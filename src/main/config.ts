import { REASONING_EFFORTS } from '../shared/session.js';
import { appearanceSchema } from './appearance-schema.js';
/**
 * Non-secret settings, stored as one small JSON file in the app's userData folder.
 * No database: there are at most a handful of roots and a dozen booleans.
 *
 * Everything read from disk is re-validated, because a hand-edited or corrupted file
 * must not be able to widen permissions or smuggle in a root that was never approved.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CAPABILITIES,
  CHAT_BROWSERS,
  DEFAULT_CAPABILITIES,
  WRITE_CAPABILITIES,
  type Capabilities,
  DESKTOP_CAPABILITIES,
  type CompactionSettings,
  type Config,
  type MultiAgentSettings,
  type Root,
  type SessionSettings
} from '../shared/types.js';
import { logError } from './logger.js';
import { RESERVED_ROOT_NAMES } from './sandbox.js';
import { capabilitiesForPlatform } from './platform.js';

/**
 * Defaults for the newer sections, in one place so the schema and defaultConfig()
 * cannot drift apart.
 *
 * Recording is always ON and retained without an age limit. Everything the app is actually
 * for — the readable timeline, Compact & resume, and agent attribution — reads that durable
 * history. It writes only to this app's own data folder and uploads nothing. The separate
 * bounded image store keeps its own quota and explicit cleanup controls.
 *
 * Existing configs still keep every explicit permission choice. Fresh installs are different:
 * the Home screen is meant to start fully usable, so every tool permission and the agents
 * surface begin enabled. The migration defaults below remain conservative so an upgrade never
 * widens an older config merely because a field did not exist when that config was written.
 */
/**
 * Where the pressure meter turns amber and red.
 *
 * These are measured in *this app's* units — `estimateTokens`, four characters to a token,
 * over the events it kept — and not in whatever ChatGPT counts. The two are not the same
 * number and never will be: the app cannot see the system prompt, the memory, the file
 * attachments or the model's own reasoning, and ChatGPT's counter is private.
 *
 * So the thresholds are calibrated against observed behaviour rather than a published
 * context window. The first pair (180k/200k) was set from the published figure, and a real
 * session then ran past 400k of these units before ChatGPT would take no more — meaning the
 * meter had been demanding a compaction since roughly the halfway mark, for hours, on a
 * chat that was fine. A warning that cries wolf at half the real capacity is a warning
 * people learn to click past, which costs more than having no warning at all.
 *
 * 300k/400k put the amber line where there was still comfortable room to compact and the
 * red line at the point that had actually been seen to fail. In use that was still early:
 * chats sat amber and compacted themselves well before anything was wrong with them, and a
 * threshold that fires on a conversation that is fine costs a fresh chat every time. The
 * window is 400k now, at the figure the ceiling has actually been observed near, and the
 * red line follows it a third further on.
 *
 * All of it remains a setting, because the real ceiling moves with the account, the model
 * and the size of what is attached.
 */
const DEFAULT_CONTEXT_WINDOW = 400_000;
const DEFAULT_SESSIONS: SessionSettings = {
  record: false,
  retainDays: 30,
  advisoryTokens: DEFAULT_CONTEXT_WINDOW,
  // Derived, never typed. The Chat panel writes `limit = threshold × 4/3` on every save,
  // so a default that did not already satisfy that relation would be a state the UI cannot
  // produce: the red line would move the first time anyone opened the panel and saved.
  limitTokens: Math.round((DEFAULT_CONTEXT_WINDOW * 4) / 3)
};

/**
 * The 1.7.1 recalibration, applied once to configs that never chose their own numbers.
 *
 * Raising a default only helps a fresh install: every existing config was written with the
 * old figures spelled out, so it would keep the too-early warning forever. A stored pair
 * that is *exactly* the old defaults was never a decision — it is what the app wrote for
 * itself — so it moves. Anything else the user typed, and it stays put.
 */
const OLD_TOKEN_DEFAULTS = [
  { advisoryTokens: 180_000, limitTokens: 200_000 },
  { advisoryTokens: 300_000, limitTokens: 400_000 }
];
const DEFAULT_COMPACTION: CompactionSettings = {
  // On, at the advisory line.
  //
  // Automatic compaction is edge-triggered since 1.8: an old chat that merely opens above
  // this number does nothing. That is what makes the advisory line usable as the trigger —
  // the crossing turn still finishes and still writes its handoff, rather than the app
  // waiting for a chat that is already over the line and compacting it on sight.
  auto: false,
  autoTokens: DEFAULT_SESSIONS.advisoryTokens
};
// Two workers, not three: three concurrent workers reproducibly trips ChatGPT's rate limit
// ("too many requests"), which strands the run rather than making it faster.
const DEFAULT_MULTI_AGENT: MultiAgentSettings = {
  enabled: false,
  maxWorkers: 2,
  allowUnattributedCalls: false,
  // Off: reopening a worker or prime chat is the user's choice to make.
  recoverAgentTabs: false
};
/** Fresh-install exposure. Kept separate from migration defaults on purpose. */
const ALL_FIRST_LAUNCH_CAPABILITIES: Capabilities = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability, true])
) as Capabilities;
// Unattributed calls start permitted on a fresh install for the same reason recording does:
// the ambiguity fences refuse work when the extension cannot *prove* the caller, and a new
// install is exactly where that evidence path is least likely to be healthy yet. Off, the
// first thing a user sees is CALLER_IDENTITY_REQUIRED; on, the work runs and its activity is
// still labelled Unattributed rather than guessed onto a chat. This relaxes only the fences —
// a positively known dormant/retired/ended worker is refused either way. `DEFAULT_MULTI_AGENT`
// keeps `false` so an upgrade never relaxes an older config merely because the field was
// absent when that config was written.
const FIRST_LAUNCH_MULTI_AGENT: MultiAgentSettings = {
  ...DEFAULT_MULTI_AGENT,
  enabled: true,
  allowUnattributedCalls: true
};

const rootSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Root names are lowercase letters, digits, dot, dash, underscore'),
  path: z.string().min(2).max(4096)
});

/**
 * Repairs root names from older/hand-edited configs without ever publishing an ambiguous
 * virtual namespace. Reserved names and duplicates are renamed deterministically in input
 * order, preserving the first usable spelling and suffixing later collisions.
 */
function uniqueStoredRoots(roots: Root[]): Root[] {
  const used = new Set<string>();
  const nextFree = (wanted: string): string => {
    const reserved = RESERVED_ROOT_NAMES.has(wanted);
    const base = reserved ? `${wanted}-folder` : wanted;
    let candidate = base.slice(0, 32);
    for (let suffix = 2; RESERVED_ROOT_NAMES.has(candidate) || used.has(candidate); suffix++) {
      const tail = `-${suffix}`;
      candidate = `${base.slice(0, Math.max(1, 32 - tail.length))}${tail}`;
    }
    return candidate;
  };
  return roots.map((root) => {
    const name = nextFree(root.name);
    used.add(name);
    return name === root.name ? root : { ...root, name };
  });
}

/**
 * Migrates configs written before the tools were consolidated.
 *
 * `powershell` and `command` used to be one tool each and are now the single
 * `exec_command`, so a user who had granted only PowerShell keeps the ability they
 * chose. `deleteFolder` is dropped rather than folded into `deleteFile`: they were never
 * the same permission, and quietly turning one into the other would widen what the user
 * approved. Both keys are removed afterwards so the file stops carrying dead permissions.
 */
function migrateCapabilities(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const caps = { ...(value as Record<string, unknown>) };
  if (caps['powershell'] === true) caps['command'] = true;
  delete caps['powershell'];
  delete caps['deleteFolder'];
  return caps;
}

// Missing capability keys are filled from safe defaults so adding a new optional
// permission in an update never resets an existing user's folders/tunnel settings.
const capabilitiesSchema = z
  .preprocess(
    migrateCapabilities,
    z.object(
      Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean().optional()])) as Record<
        (typeof CAPABILITIES)[number],
        z.ZodOptional<z.ZodBoolean>
      >
    )
  )
  .transform((caps) => ({ ...DEFAULT_CAPABILITIES, ...caps }) as Capabilities);

/**
 * The user's own MCP instructions.
 *
 * Empty by default, and deliberately so: the connector instructions are how the app explains
 * its own tools, and inventing text on the user's behalf there would put words the app cannot
 * honour in front of the model.
 */
export const MAX_MCP_INSTRUCTIONS_CHARS = 4000;
const DEFAULT_MCP = { instructions: '' } as const;

const configSchema = z.object({
  // A config written by hand — or by a build before `/skills` was reserved — must not be
  // able to claim a reserved virtual root. Renamed rather than rejected: a single bad root
  // name is not a reason to throw away the whole config and every other approved folder.
  roots: z
    .array(rootSchema)
    .max(32)
    .transform(uniqueStoredRoots),
  capabilities: capabilitiesSchema,
  readOnly: z.boolean(),
  tunnel: z.object({
    profileId: z.string().min(1).max(64).optional(),
    profileName: z.string().trim().min(1).max(80).optional(),
    profileEpoch: z.number().int().nonnegative().optional(),
    kind: z.enum(['openai', 'cloudflared', 'manual']),
    tunnelId: z.string().max(128),
    // Optional with an empty default, so a config written before the connector split
    // loads unchanged and simply has no Desktop tunnel yet — which is also the correct
    // state for it, since the user has not created that connector in ChatGPT either.
    desktopTunnelId: z.string().max(128).optional().default(''),
    pluginsTunnelId: z.string().max(128).optional().default(''),
    binaryPath: z.string().max(4096)
  }),
  setupProfiles: z.array(z.object({
    id: z.string().min(1).max(64), name: z.string().trim().min(1).max(80),
    tunnelId: z.string().max(128), desktopTunnelId: z.string().max(128), pluginsTunnelId: z.string().max(128)
  })).max(11).refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'Duplicate setup profile').optional(),
  ui: z.object({
    appearance: appearanceSchema.optional().catch(undefined),
    chatBrowser: z.enum(CHAT_BROWSERS).optional().default('chrome'),
    developerMode: z.boolean().optional(),
    finishTool: z.boolean().optional(),
    finishLeadMinutes: z.number().int().min(3).max(5).optional(),
    planModel: z.string().trim().min(1).max(80).optional().default('gpt-5.6-sol').catch('gpt-5.6-sol'),
    planReasoning: z.enum(['', ...REASONING_EFFORTS]).optional().default('high').catch('high'),
    backgroundChats: z.boolean().optional().default(true),
    browserOnly: z.boolean().optional().default(false),
    autoRefreshPlugins: z.boolean().optional().default(false),
    tabsToKeepOpen: z.number().int().min(1).max(50).optional(),
    minimizeToTray: z.boolean(),
    autoConnect: z.boolean(),
    startAtLogin: z.boolean().optional().default(false),
    privacyScreenshots: z.boolean().optional().default(false),
    // Dark is the design the app is drawn for, and a config written before the theme
    // existed has no stored answer to override — so it is the default rather than the
    // fallback. An explicit `light` is somebody's own choice and is never touched.
    theme: z.enum(['light', 'dark']).optional().default('dark')
  }),
  // Whole sections are optional, so a config written by an older build keeps working
  // and simply gains the new features switched off. The default object is spelled out
  // rather than left as {} because zod 4 returns a default as-is instead of parsing it.
  sessions: z
    .object({
      record: z.boolean().optional().default(DEFAULT_SESSIONS.record),
      retainDays: z.number().int().min(0).max(3650).optional().default(DEFAULT_SESSIONS.retainDays),
      advisoryTokens: z
        .number()
        .int()
        .min(10_000)
        .max(4_000_000)
        .optional()
        .default(DEFAULT_SESSIONS.advisoryTokens),
      limitTokens: z.number().int().min(10_000).max(4_000_000).optional().default(DEFAULT_SESSIONS.limitTokens)
    })
    .optional()
    .default({ ...DEFAULT_SESSIONS }),
  compaction: z
    .object({
      auto: z.boolean().optional().default(DEFAULT_COMPACTION.auto),
      // The floor is high enough that the threshold cannot be set somewhere a fresh chat
      // is already past, which would compact every conversation the moment it started.
      autoTokens: z
        .number()
        .int()
        .min(10_000)
        .max(4_000_000)
        .optional()
        .default(DEFAULT_COMPACTION.autoTokens)
    })
    .optional()
    .default({ ...DEFAULT_COMPACTION }),
  multiAgent: z
    .object({
      enabled: z.boolean().optional().default(DEFAULT_MULTI_AGENT.enabled),
    defaultModel: z.string().max(80).optional(),
    defaultReasoning: z.enum(['', ...REASONING_EFFORTS]).optional(),
      maxWorkers: z.number().int().min(1).max(8).optional().default(DEFAULT_MULTI_AGENT.maxWorkers),
      allowUnattributedCalls: z.boolean().optional().default(DEFAULT_MULTI_AGENT.allowUnattributedCalls),
      recoverAgentTabs: z.boolean().optional().default(DEFAULT_MULTI_AGENT.recoverAgentTabs)
    })
    .optional()
    .default({ ...DEFAULT_MULTI_AGENT }),
  mcp: z
    .object({
      // Repaired rather than rejected: this is free text a person typed, and one over-long or
      // malformed field must not send the whole config through conservative recovery.
      instructions: z
        .string()
        .optional()
        .default(DEFAULT_MCP.instructions)
        .transform((value) => value.slice(0, MAX_MCP_INSTRUCTIONS_CHARS).trim())
        .catch(DEFAULT_MCP.instructions)
    })
    .optional()
    .default({ ...DEFAULT_MCP })
    .catch({ ...DEFAULT_MCP })
});

/**
 * Fresh-install Desktop exposure differs by host. Windows starts the Desktop group on. macOS has
 * a native backend too, but it starts **off** and is switched on by the user: every Desktop
 * action there also needs Screen Recording / Accessibility consent from System Settings, and a
 * fresh install must not publish a second connector nobody can use yet. Unsupported hosts mask
 * the group at the platform boundary while preserving stored choices for a moved config.
 */
function firstLaunchCapabilities(platform: NodeJS.Platform, release?: string): Capabilities {
  const capabilities = capabilitiesForPlatform({ ...ALL_FIRST_LAUNCH_CAPABILITIES }, platform, release);
  if (platform === 'darwin') for (const capability of DESKTOP_CAPABILITIES) capabilities[capability] = false;
  return capabilities;
}

export function defaultConfig(platform: NodeJS.Platform = process.platform, release?: string): Config {
  return {
    roots: [],
    capabilities: firstLaunchCapabilities(platform, release),
    readOnly: false,
    tunnel: { kind: 'openai', tunnelId: '', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, startAtLogin: false, privacyScreenshots: false, theme: 'dark', autoRefreshPlugins: false, backgroundChats: true, planModel: 'gpt-5.6-sol', planReasoning: 'high' },
    sessions: { ...DEFAULT_SESSIONS },
    compaction: { ...DEFAULT_COMPACTION },
    multiAgent: { ...FIRST_LAUNCH_MULTI_AGENT },
    mcp: { ...DEFAULT_MCP }
  };
}

/**
 * Recovery for a config file that exists but cannot be trusted.
 *
 * A missing file is a real first launch and intentionally gets the fully-enabled defaults
 * above. A malformed/corrupt existing file is different: treating damage as consent would
 * widen filesystem/desktop/process access merely because parsing failed. Keep that path on
 * the historical narrow capability set and read-only mode until the user saves settings again.
 */
function conservativeRecoveryConfig(): Config {
  return {
    ...defaultConfig(),
    capabilities: { ...DEFAULT_CAPABILITIES },
    readOnly: true,
    multiAgent: { ...DEFAULT_MULTI_AGENT },
    ui: { ...defaultConfig().ui },
  };
}

let configPath = '';
let current: Config = defaultConfig();
// Every UI mutation ultimately lands in the same tiny JSON file. Keep those
// read-modify-write transactions strictly ordered so two fast checkbox/root changes
// cannot race on config.json.tmp or overwrite each other's newer state.
let mutationQueue: Promise<void> = Promise.resolve();

export function initConfigPath(userDataDir: string): void {
  configPath = path.join(userDataDir, 'config.json');
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = configSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logError('Settings file was invalid and has been reset to defaults');
      current = conservativeRecoveryConfig();
    } else {
      current = adoptWiderWindow(adoptAutoCompaction(recalibrateTokens(parsed.data)));
      // Duplicate root names would make a virtual path ambiguous.
      const seen = new Set<string>();
      current.roots = current.roots.filter((r) => {
        const key = r.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(`Could not read settings: ${(err as Error).message}`);
      current = conservativeRecoveryConfig();
    } else {
      current = defaultConfig();
    }
  }
  return current;
}

/** Applies any superseded pair in OLD_TOKEN_DEFAULTS → DEFAULT_SESSIONS, untouched pairs only. */
function recalibrateTokens(config: Config): Config {
  const { advisoryTokens, limitTokens } = config.sessions;
  const untouched = OLD_TOKEN_DEFAULTS.some(
    (old) => advisoryTokens === old.advisoryTokens && limitTokens === old.limitTokens
  );
  if (!untouched) {
    return config;
  }
  return {
    ...config,
    sessions: {
      ...config.sessions,
      advisoryTokens: DEFAULT_SESSIONS.advisoryTokens,
      limitTokens: DEFAULT_SESSIONS.limitTokens
    }
  };
}

/**
 * What automatic compaction used to default to, for the same one-time move as above.
 *
 * A config written before 1.7.5 spells the old answer out, so raising the default alone
 * would only ever reach a fresh install. A stored pair that is *exactly* the old default
 * was never a decision — it is what the app wrote for itself — so it moves. Anything the
 * user actually chose is left alone, including switching it off on purpose, which is why
 * `auto: true` with the old threshold is not touched: that is somebody's own setting.
 */
const OLD_AUTO_DEFAULTS = { auto: false, autoTokens: 300_000 };

function adoptAutoCompaction(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== OLD_AUTO_DEFAULTS.auto || autoTokens !== OLD_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, auto: DEFAULT_COMPACTION.auto, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

/**
 * The 1.8 automatic default, moved up with the window.
 *
 * This is the third time a stored number that was never chosen has had to follow a default,
 * and it is the one case where the file's own rule is uncomfortable. `adoptAutoCompaction`
 * above deliberately leaves `auto: true` at the old threshold alone, on the grounds that
 * switching it on was a decision — but that was written when `auto: false` was the shipped
 * default. Since 1.8 the app writes `auto: true` at 300k for itself, so the two populations
 * are no longer distinguishable in the file, and the larger of them never decided anything.
 *
 * They move. A threshold that is any other number was typed by somebody and stays.
 *
 * There is no matching migration downward: 400k is what this now defaults to, so a config
 * that already holds it, whether from 1.7 or from a person, simply keeps it.
 */
const SUPERSEDED_AUTO_DEFAULTS = { auto: true, autoTokens: 300_000 };

function adoptWiderWindow(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== SUPERSEDED_AUTO_DEFAULTS.auto || autoTokens !== SUPERSEDED_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

export function getConfig(): Config {
  return current;
}

/**
 * Read-only mode is enforced here as well as at the tool layer, so the effective
 * capability set can never disagree with what the UI shows.
 */
export function effectiveCapabilities(
  config: Config,
  platform: NodeJS.Platform = process.platform,
  release?: string
): Capabilities {
  const live = capabilitiesForPlatform(config.capabilities, platform, release);
  if (!config.readOnly) return live;
  // Derived from WRITE_CAPABILITIES rather than listed again here, so adding a new
  // writing capability cannot accidentally leave it enabled in read-only mode.
  const capped = { ...live };
  for (const capability of WRITE_CAPABILITIES) capped[capability] = false;
  return capped;
}

async function persistConfig(next: Config): Promise<Config> {
  const parsed = configSchema.parse(next);
  const tmp = `${configPath}.tmp`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf8');
  await fs.rename(tmp, configPath);
  // Only publish the new in-memory state after the durable write succeeded. A disk
  // error must not leave the UI believing settings were saved when they were not.
  current = parsed;
  return current;
}

/**
 * Atomically updates settings from the latest committed state.
 *
 * The callback itself runs inside the queue. This matters more than merely queuing the
 * final file write: a root change and a permission change that start at the same time
 * must each see the result of the one ahead of it instead of composing two stale full
 * Config objects and letting the later write silently erase the earlier change.
 */
export function updateConfig(
  update: (latest: Config) => Config | Promise<Config>,
  afterPublish?: (next: Config, previous: Config) => void | Promise<void>
): Promise<Config> {
  const operation = mutationQueue.then(async () => {
    const previous = current;
    const next = await persistConfig(await update(previous));
    // Keep dependent durable retirement inside the same settings transaction;
    // the next On cannot overtake a published Off's cancellation work.
    await afterPublish?.(next, previous);
    return next;
  });
  mutationQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

/** Replaces the complete config. Prefer updateConfig for read-modify-write changes. */
export function saveConfig(next: Config): Promise<Config> {
  return updateConfig(() => next);
}
