import { REASONING_EFFORTS } from '../src/shared/session.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultConfig,
  initConfigPath,
  loadConfig,
  saveConfig,
  updateConfig
} from '../src/main/config.js';
import { DESKTOP_CAPABILITIES, type Capability } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-config-');
  initConfigPath(dir);
});

afterAll(async () => {
  await removeTempDir(dir);
});

describe('settings migration', () => {
  it('round-trips custom appearance and isolates malformed appearance from permissions', async () => {
    const { defaultAppearance } = await import('../src/shared/appearance.js');
    const config = defaultConfig(); config.readOnly = true; config.capabilities.command = false;
    expect(config.ui.appearance).toBeUndefined();
    const appearance = defaultAppearance(); appearance.dark.sidebar = '#e53aa0'; appearance.fontSize = 18;
    await saveConfig({ ...config, ui: { ...config.ui, appearance } });
    expect((await loadConfig()).ui.appearance).toEqual(appearance);
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...config,
      ui: { ...config.ui, appearance: { ...appearance, fontSize: 900 } } }), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(true); expect(loaded.capabilities.command).toBe(false);
    expect(loaded.ui.appearance).toBeUndefined();
  });
  it('drops removed file-saving settings without changing other saved choices', async () => {
    const config = defaultConfig();
    config.readOnly = true;
    config.capabilities.command = false;
    const legacy = {
      ...config,
      capabilities: { ...config.capabilities, saveArtifact: true },
      artifacts: { maxFileBytes: 20 * 1024 * 1024 }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    const loaded = await loadConfig();
    expect(loaded).toMatchObject(config);
    expect(loaded).not.toHaveProperty('artifacts');
    expect(loaded.capabilities).not.toHaveProperty('saveArtifact');
    await saveConfig(loaded);
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(stored).not.toHaveProperty('artifacts');
    expect(stored.capabilities).not.toHaveProperty('saveArtifact');
  });

  it('defaults background chats on for fresh and omitted settings while preserving saved choices', async () => {
    expect(defaultConfig().ui.backgroundChats).toBe(true);
    expect((await loadConfig()).ui.backgroundChats).toBe(true);
    const legacy = defaultConfig(); delete legacy.ui.backgroundChats;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).ui.backgroundChats).toBe(true);
    for (const backgroundChats of [false, true]) {
      await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, backgroundChats } });
      expect((await loadConfig()).ui.backgroundChats).toBe(backgroundChats);
    }
  });
  it('defaults login startup off for fresh and legacy settings independently of auto-connect', async () => {
    expect(defaultConfig().ui.startAtLogin).toBe(false);
    const legacy = defaultConfig();
    delete legacy.ui.startAtLogin;
    legacy.ui.autoConnect = true;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).ui).toMatchObject({ startAtLogin: false, autoConnect: true });
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, startAtLogin: true, autoConnect: false } });
    expect((await loadConfig()).ui).toMatchObject({ startAtLogin: true, autoConnect: false });
  });
  it('defaults automatic plugin refresh off for fresh and legacy settings while preserving explicit opt-in', async () => {
    expect(defaultConfig().ui.autoRefreshPlugins).toBe(false);
    const legacy = defaultConfig(); delete legacy.ui.autoRefreshPlugins;
    await saveConfig(legacy);
    expect((await loadConfig()).ui.autoRefreshPlugins).toBe(false);
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoRefreshPlugins: true } });
    expect((await loadConfig()).ui.autoRefreshPlugins).toBe(true);
  });
  it('preserves explicit local recording and retention choices', async () => {
    const chosen = {
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: true, retainDays: 90 }
    };

    const saved = await saveConfig(chosen);
    expect(saved.sessions).toMatchObject({ record: true, retainDays: 90 });

    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(chosen), 'utf8');
    expect((await loadConfig()).sessions).toMatchObject({ record: true, retainDays: 90 });
  });

  it('preserves old settings when new safe-default capabilities and UI prefs are added', async () => {
    const oldConfig = {
      roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }],
      capabilities: {
        browse: true,
        search: true,
        read: true,
        metadata: true,
        create: true,
        edit: true,
        move: false,
        deleteFile: false,
        powershell: true,
        command: true,
        screen: true,
        control: true
      },
      readOnly: false,
      tunnel: {
        kind: 'openai',
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        binaryPath: ''
      },
      ui: { minimizeToTray: true, autoConnect: true }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(oldConfig), 'utf8');

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual(oldConfig.roots);
    expect(loaded.capabilities.create).toBe(true);
    expect(loaded.capabilities.clipboardRead).toBe(false);
    expect(loaded.capabilities.clipboardWrite).toBe(false);
    expect(loaded.ui.autoConnect).toBe(true);
    expect(loaded.ui.privacyScreenshots).toBe(false);
    // The one tunnel id a pre-split config had is Core's, because Core is the connector
    // the app cannot work without. Desktop is a second, optional tunnel that starts empty
    // rather than inheriting Core's id — publishing Core twice would be worse than not
    // publishing Desktop at all.
    expect(loaded.tunnel.tunnelId).toBe(oldConfig.tunnel.tunnelId);
    expect(loaded.tunnel.desktopTunnelId).toBe('');
  });

  it('folds a PowerShell-only permission into the single command permission', async () => {
    // `powershell` and `command` were one tool each and are now the single exec_command.
    // A user who had granted only PowerShell keeps the ability they chose; the dead key
    // does not survive into the saved config.
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...defaultConfig(),
        capabilities: {
          ...defaultConfig().capabilities,
          command: false,
          deleteFile: false,
          powershell: true,
          deleteFolder: true
        }
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.capabilities.command).toBe(true);
    expect(Object.keys(loaded.capabilities)).not.toContain('powershell');
    // `deleteFolder` is dropped rather than folded into deleteFile: they were never the
    // same permission, and turning one into the other would widen what the user approved.
    expect(Object.keys(loaded.capabilities)).not.toContain('deleteFolder');
    expect(loaded.capabilities.deleteFile).toBe(false);
  });

  it('renames a saved root that claims a reserved virtual namespace', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...defaultConfig(), roots: [{ name: 'skills', path: 'C:\\Users\\example\\skills' }] }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.roots[0]?.name).toBe('skills-folder');
    expect(loaded.roots[0]?.path).toBe('C:\\Users\\example\\skills');
  });

  it('keeps reserved-name migration from creating duplicate virtual roots', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...defaultConfig(),
        roots: [
          { name: 'skills-folder', path: 'C:\\Users\\example\\already-there' },
          { name: 'skills', path: 'C:\\Users\\example\\legacy-skills' },
          { name: 'skills-folder', path: 'C:\\Users\\example\\duplicate' }
        ]
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.roots.map((root) => root.name)).toEqual(['skills-folder', 'skills-folder-2', 'skills-folder-3']);
    expect(new Set(loaded.roots.map((root) => root.name)).size).toBe(loaded.roots.length);
  });

  it('round-trips a second tunnel id for the Desktop connector', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      tunnel: {
        ...config.tunnel,
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        desktopTunnelId: 'tunnel_fedcba9876543210fedcba9876543210'
      }
    });
    const loaded = await loadConfig();
    expect(loaded.tunnel.tunnelId).toBe('tunnel_0123456789abcdef0123456789abcdef');
    expect(loaded.tunnel.desktopTunnelId).toBe('tunnel_fedcba9876543210fedcba9876543210');
  });

  /**
   * Automatic compaction ends the chat the user is working in and opens a fresh one, and it
   * used to start off on the grounds that this is not something to do to somebody who never
   * asked for it. In use that reasoning turned out to be backwards: the alternative to
   * compacting is hitting the ceiling mid-thought and losing the thread entirely, which is
   * the worse thing to have happen to somebody who never asked for it. Since 1.8 the trigger
   * is edge-based rather than "currently above the line", so the advisory line is safe as
   * the default and still leaves room to finish the crossing turn and write the handoff.
   */
  it('starts with automatic compaction on at the advisory line', async () => {
    await saveConfig(defaultConfig());
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(loaded.sessions.advisoryTokens);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  /**
   * The Chat panel offers one number and derives the red line from it, `limit = threshold ×
   * 4/3`. A shipped default that does not already satisfy that relation is a state the UI
   * cannot produce, and it would not survive contact with it: the first save of anything at
   * all in that panel would silently move the red line. So the defaults have to agree with
   * the arithmetic the panel does, which is what this pins.
   */
  it('ships a red line the settings panel would have derived itself', async () => {
    const config = defaultConfig();
    expect(config.sessions.advisoryTokens).toBe(config.compaction.autoTokens);
    expect(config.sessions.limitTokens).toBe(Math.round((config.compaction.autoTokens * 4) / 3));
  });

  /**
   * The migration, and the line it must not cross. A config still carrying both old
   * defaults never had a decision made about it, so it moves to the new one. A config
   * carrying anything else is somebody's own setting and is left exactly as it is.
   */
  it('moves an untouched old default onto the new one', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 300_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  /**
   * The window moved to 400k, and the number that has to follow it is the one the app wrote
   * for itself. Since 1.8 that is `auto: true` at 300k — the shipped default, in every config
   * written by every install that never opened the panel. Raising the default alone would
   * reach a fresh install and nothing else, which is the whole reason this file has
   * migrations at all.
   */
  it('moves the untouched 1.8 automatic default up to the wider window', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 300_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 400_000 });
  });

  /** And nothing moves back down: 400k is the default now, however a config came to hold it. */
  it('leaves a config already at the wider window alone', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 400_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 400_000 });
  });

  /**
   * The meter's own pair, migrated on the same rule. 300k/400k is what 1.8 wrote for itself,
   * so it follows the window; anything else in either slot was typed and stays.
   */
  it('recalibrates an untouched meter pair and leaves a chosen one', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, advisoryTokens: 300_000, limitTokens: 400_000 } });
    const moved = await loadConfig();
    expect(moved.sessions.advisoryTokens).toBe(400_000);
    expect(moved.sessions.limitTokens).toBe(Math.round((400_000 * 4) / 3));

    await saveConfig({ ...config, sessions: { ...config.sessions, advisoryTokens: 300_000, limitTokens: 350_000 } });
    const kept = await loadConfig();
    expect(kept.sessions).toMatchObject({ advisoryTokens: 300_000, limitTokens: 350_000 });
  });

  it('leaves a user who turned automatic compaction off turned off', async () => {
    const config = defaultConfig();
    // Off, but at a threshold they chose: that is a decision, not an untouched default.
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 250_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(false);
    expect(loaded.compaction.autoTokens).toBe(250_000);
  });

  it('keeps an automatic compaction the user configured', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      compaction: { ...config.compaction, auto: true, autoTokens: 150_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 150_000 });
  });

  it('keeps the meter threshold aligned with a high automatic-compaction threshold', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      sessions: { ...config.sessions, advisoryTokens: 3_000_000, limitTokens: 4_000_000 },
      compaction: { ...config.compaction, auto: true, autoTokens: 3_000_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.compaction.autoTokens).toBe(3_000_000);
    expect(loaded.sessions.advisoryTokens).toBe(3_000_000);
    expect(loaded.sessions.limitTokens).toBe(4_000_000);
  });

  /**
   * A config written before these fields existed gets the current defaults, like any other
   * absent field: absent is not a decision, so it reads as whatever the app decides now.
   */
  it('reads a config from before the setting existed as the current default', async () => {
    const config = defaultConfig();
    const older = { ...config, compaction: { ...config.compaction } } as Record<string, any>;
    delete older.compaction.auto;
    delete older.compaction.autoTokens;
    await saveConfig(older as ReturnType<typeof defaultConfig>);
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  it('serializes concurrent read-modify-write changes instead of losing one', async () => {
    await saveConfig(defaultConfig());
    const first = updateConfig(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...config, roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }] };
    });
    const second = updateConfig((config) => ({
      ...config,
      ui: { ...config.ui, theme: 'dark' as const }
    }));
    await Promise.all([first, second]);

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual([{ name: 'project', path: 'C:\\Users\\example\\project' }]);
    expect(loaded.ui.theme).toBe('dark');
  });
});

/** Fresh-install defaults, while migrations above prove existing choices stay narrow. */
describe('shipped defaults', () => {
  // Windows starts the group on; Linux starts its extension browser capabilities on.
  // macOS preserves its existing off default and separate native OS consent.
  const expectedFreshCapability = (capability: Capability, platform: NodeJS.Platform): boolean =>
    platform === 'win32' || !DESKTOP_CAPABILITIES.includes(capability) ||
    (platform !== 'darwin' && (capability === 'screen' || capability === 'control'));

  it('keeps local session recording opt-in with bounded fresh-install retention', () => {
    expect(defaultConfig().sessions).toMatchObject({ record: false, retainDays: 30 });
  });

  it('loads a genuinely missing config with every portable Core capability enabled', async () => {
    await fs.rm(path.join(dir, 'config.json'), { force: true });
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(false);
    for (const [capability, enabled] of Object.entries(loaded.capabilities) as Array<[Capability, boolean]>) {
      expect(enabled, capability).toBe(expectedFreshCapability(capability, process.platform));
    }
    expect(loaded.multiAgent.enabled).toBe(true);
    expect(loaded.multiAgent.allowUnattributedCalls).toBe(true);
    expect(loaded.multiAgent.recoverAgentTabs).toBe(false);
  });

  it.each(['win32', 'darwin', 'linux'] as const)(
    'starts portable permissions on and Desktop automation on Windows only on %s',
    (platform) => {
      const config = defaultConfig(platform);
      expect(config.readOnly).toBe(false);
      for (const [capability, enabled] of Object.entries(config.capabilities) as Array<[Capability, boolean]>) {
        expect(enabled, `${platform}:${capability}`).toBe(expectedFreshCapability(capability, platform));
      }
      expect(config.multiAgent.enabled).toBe(true);
      expect(config.multiAgent.maxWorkers).toBe(2);
      expect(config.multiAgent.allowUnattributedCalls).toBe(true);
      expect(config.multiAgent.recoverAgentTabs).toBe(false);
    }
  );

  it('does not widen omitted permissions or agents exposure in an existing legacy config', async () => {
    const legacy = {
      roots: [],
      capabilities: { browse: true, search: true, read: true, metadata: true },
      readOnly: true,
      tunnel: { kind: 'openai', tunnelId: '', binaryPath: '' },
      ui: { minimizeToTray: true, autoConnect: false }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.capabilities.command).toBe(false);
    expect(loaded.capabilities.control).toBe(false);
    expect(loaded.multiAgent.enabled).toBe(false);
    expect(loaded.multiAgent.allowUnattributedCalls).toBe(false);
    expect(loaded.multiAgent.recoverAgentTabs).toBe(false);
    expect(loaded.readOnly).toBe(true);
  });

  it('does not turn config corruption into permission consent', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), '{ definitely-not-json', 'utf8');
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(true);
    expect(loaded.capabilities.command).toBe(false);
    expect(loaded.capabilities.control).toBe(false);
    expect(loaded.multiAgent.enabled).toBe(false);
  });

  it('persists local recording and retention choices', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: false, retainDays: 3650 } });
    expect((await loadConfig()).sessions).toMatchObject({ record: false, retainDays: 3650 });
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(stored.sessions).toMatchObject({ record: false, retainDays: 3650 });
  });

  it('applies the new default to a config written before the setting existed', async () => {
    const before = defaultConfig() as unknown as Record<string, unknown>;
    const { sessions: _dropped, ...withoutSessions } = before;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(withoutSessions), 'utf8');
    expect((await loadConfig()).sessions).toMatchObject({ record: false, retainDays: 30 });
  });

  /**
   * Save, close, reopen. The unattributed switch is on out of the box, so the only way to
   * see it off is to have turned it off — and that choice has to survive the next launch
   * rather than being handed back the fresh-install default on load.
   */
  it('keeps either unattributed choice across a save and reload', async () => {
    const config = defaultConfig();
    expect(config.multiAgent.allowUnattributedCalls).toBe(true);

    await saveConfig({
      ...config,
      multiAgent: { ...config.multiAgent, allowUnattributedCalls: false }
    });
    expect((await loadConfig()).multiAgent.allowUnattributedCalls).toBe(false);

    await saveConfig({
      ...config,
      multiAgent: { ...config.multiAgent, allowUnattributedCalls: true }
    });
    expect((await loadConfig()).multiAgent.allowUnattributedCalls).toBe(true);
  });
});

it.each(REASONING_EFFORTS)('retains canonical worker effort %s across settings save and reload', async effort => {
  const config = defaultConfig();
  config.multiAgent.defaultReasoning = effort;
  await saveConfig(config);
  const loaded = await loadConfig();
  expect(loaded.multiAgent.defaultReasoning).toBe(effort);
});
