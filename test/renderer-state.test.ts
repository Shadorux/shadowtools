vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({ update: vi.fn() }) }));
// Native animation/media APIs are covered by pet DOM and real Electron tests.
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => () => {} }));
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS } from '../src/shared/browser-control.js';

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

it('does not overwrite a focused dirty settings field on an unsolicited state push', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  let stateListener: (state: any) => void = () => undefined;
  const baseConfig = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: true,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: false, edit: false, move: false, deleteFile: false, command: false,
      screen: false, control: false, clipboardRead: false, clipboardWrite: false
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true }
  };
  const state = {
    config: baseConfig,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
        resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  };
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const api: any = new Proxy({
    getState: () => ok(state),
    getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onStateChanged: (fn: any) => { stateListener = fn; return () => undefined; },
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const field = w.document.getElementById('tunnelId') as HTMLInputElement;
  expect(field.value).toBe(baseConfig.tunnel.tunnelId);
  field.focus();
  field.value = 'tunnel_USER_IS_STILL_TYPING';

  stateListener(structuredClone(state));

  expect(w.document.activeElement).toBe(field);
  expect(field.value).toBe('tunnel_USER_IS_STILL_TYPING');

  const multiAgent = w.document.getElementById('homeMaEnabled') as HTMLInputElement;
  multiAgent.focus();
  multiAgent.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(multiAgent);
  expect(multiAgent.checked).toBe(true);

  const allowUnattributed = w.document.getElementById('allowUnattributedCalls') as HTMLInputElement;
  allowUnattributed.focus();
  allowUnattributed.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(allowUnattributed);
  expect(allowUnattributed.checked).toBe(true);

  // The health card reports the live surface projection rather than a hand-maintained
  // denominator. Tool consolidation/additions should never leave the UI saying "of 9"
  // when nine is no longer the product's actual maximum.
  const withTools = structuredClone(state) as any;
  withTools.status.surfaces = [
    {
      id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
      available: true, localUrl: null, publicUrl: null, tools: ['read', 'apply_patch'],
      state: 'off', detail: '', lastRequestAt: null, lastToolCallAt: null
    },
    {
      id: 'desktop', connectorName: 'Desktop', description: '', cardSummary: '', optional: true,
      available: true, localUrl: null, publicUrl: null, tools: ['observe'],
      state: 'off', detail: '', lastRequestAt: null, lastToolCallAt: null
    }
  ];
  stateListener(withTools);
  expect(w.document.getElementById('facts')!.textContent).toContain('Tools across Core + Desktop3 total');
  expect(w.document.getElementById('facts')!.textContent).not.toContain('of 9');

  const withMissingMacAccess = structuredClone(withTools) as any;
  withMissingMacAccess.platform = { family: 'macos', name: 'macOS', desktopAutomation: true };
  withMissingMacAccess.config.readOnly = false;
  withMissingMacAccess.config.capabilities.screen = true;
  withMissingMacAccess.config.capabilities.control = true;
  withMissingMacAccess.desktopAccess = {
    screen: 'granted',
    accessibility: 'missing',
    checkedAt: 1,
    error: null
  };
  stateListener(withMissingMacAccess);
  const accessWarning = w.document.getElementById('desktopAccess')!;
  expect(accessWarning.hidden).toBe(false);
  expect(accessWarning.textContent).toContain('Accessibility: missing');
  expect(accessWarning.textContent).toContain('live verdicts from the native backend');
  expect((w.document.getElementById('openDesktopScreen') as HTMLButtonElement).hidden).toBe(true);
  expect((w.document.getElementById('openDesktopAccessibility') as HTMLButtonElement).hidden).toBe(false);

  const withReadOnlyMacAccess = structuredClone(withMissingMacAccess) as any;
  withReadOnlyMacAccess.config.readOnly = true;
  stateListener(withReadOnlyMacAccess);
  expect(accessWarning.hidden).toBe(true);
});

it('serializes settings intent so rapid toggles and later UI changes cannot undo each other', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const baseConfig = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as 'light' | 'dark' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true }
  };
  const appState = (config: typeof baseConfig) => ({
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
        resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  });
  let current = appState(baseConfig);
  const calls: any[] = [];
  const pending: Array<(reply: any) => void> = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const saveSettings = (patch: any) => {
    calls.push(structuredClone(patch));
    return new Promise<any>((resolve) => pending.push(resolve));
  };
  const api: any = new Proxy({
    getState: () => ok(current),
    getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    saveSettings,
    onStateChanged: () => () => undefined,
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  // First save toggles a value that has no form control of its own. Keep the IPC unresolved,
  // matching a real save that is waiting for bridge/tunnel lifecycle work in the main process.
  (w.document.getElementById('readOnlyBtn') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].readOnly).toBe(true);

  // A second click before the first acknowledgement means "back off". The old handler derived
  // both clicks from state.config.readOnly=false, so both snapshots requested true and the two
  // clicks behaved like one.
  (w.document.getElementById('readOnlyBtn') as HTMLButtonElement).click();

  // While both are queued, change an unrelated checkbox. It must inherit the latest requested
  // read-only intent rather than the stale acknowledged state.
  const auto = w.document.getElementById('autoConnect') as HTMLInputElement;
  auto.checked = true;
  auto.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toHaveLength(1);

  current = appState({ ...baseConfig, readOnly: true });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1].readOnly).toBe(false);
  expect(calls[1].ui.autoConnect).toBe(false);

  current = appState({ ...baseConfig, readOnly: false });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2].readOnly).toBe(false);
  expect(calls[2].ui.autoConnect).toBe(true);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Appearance changes must request dark then light in order,
  // even though the first dark save has not answered yet.
  const theme = w.document.getElementById('appearanceTheme') as HTMLSelectElement;
  theme.value = 'dark'; theme.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(calls).toHaveLength(4));
  expect(calls[3].ui.theme).toBe('dark');
  theme.value = 'light'; theme.dispatchEvent(new w.Event('change', { bubbles: true }));
  expect(calls).toHaveLength(4);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true, theme: 'dark' } });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(5));
  expect(calls[4].ui.theme).toBe('light');

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true, theme: 'light' } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

interface RendererMount {
  window: JSDOM['window'];
  calls: any[];
  keys: Array<{ method: string; value: string }>;
  push(state: any): void;
  state: any;
}

async function mountChat(
  overrides: Record<string, unknown> = {},
  _models: any[] = [],
  apiOverrides: Record<string, (...args: any[]) => any> = {},
): Promise<RendererMount> {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
  Object.assign(globalThis, { Event: w.Event });
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const config = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as const },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true }
  };
  const state: any = {
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
        resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null },
    ...overrides
  };
  let listener: (next: any) => void = () => undefined;
  const calls: any[] = [];
  const keys: Array<{ method: string; value: string }> = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getLog: () => ok([]),
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onStateChanged: (fn: any) => {
        listener = fn;
        return () => undefined;
      },
      onLogEntry: () => () => undefined,
      onSwarmChanged: () => () => undefined,
      onSessionChanged: () => () => undefined,
      listSessions: () => ok({ sessions: [], activeId: null, pressure: [] }),
      // Answers with the config it just stored, the way the real handler does. The panel
      // paints from the app's answer rather than from what it just clicked, so a fake that
      // replied with the old config would be testing a revert.
      saveSettings: (patch: any) => {
        calls.push(structuredClone(patch));
        state.config = { ...state.config, ...structuredClone(patch) };
        return ok(state);
      },
      setApiKey: (value: string) => {
        keys.push({ method: 'setApiKey', value });
        return ok(state);
      },
      ...apiOverrides
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return (..._args: any[]) => ok(null);
      }
    }
  );
  Object.defineProperty(w, 'api', { value: api, configurable: true });
  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { window: w, calls, keys, state, push: (next) => listener(next) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const projectSidebarFixture = () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Collapsed project', path: 'C:\\repo', createdAt: 1 };
  const session = { id: 'project-session', title: 'Project task', conversationId: 'chat-project', chatIds: ['chat-project'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null, projectId: project.id };
  return { project, session };
};

it('starts project groups collapsed and deliberately expands the project selected for a new chat', async () => {
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const group = () => mounted.window.document.querySelector<HTMLDetailsElement>(`[data-project-id="${project.id}"]`)!;
  await vi.waitFor(() => expect(group()).not.toBeNull());
  expect(group().open).toBe(false);
  (group().querySelector('.project-new') as HTMLButtonElement).click();
  expect(group().open).toBe(true);
});

it('commits a project summary click before an immediate state repaint replaces its details node', async () => {
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const group = () => mounted.window.document.querySelector<HTMLDetailsElement>(`[data-project-id="${project.id}"]`)!;
  await vi.waitFor(() => expect(group()).not.toBeNull());
  (group().querySelector(`[data-id="${session.id}"]`) as HTMLButtonElement).click();
  expect(group().open).toBe(true);
  const clicked = group();
  clicked.querySelector('summary')!.click();
  expect(clicked.open).toBe(false);
  mounted.push(structuredClone(mounted.state));
  expect(group()).not.toBe(clicked);
  expect(group().open).toBe(false);
  await settle();
  expect(group().open).toBe(false);

  // Native keyboard activation dispatches the same cancelable click with detail 0.
  group().querySelector('summary')!.dispatchEvent(new mounted.window.MouseEvent('click', {
    bubbles: true, cancelable: true, detail: 0
  }));
  expect(group().open).toBe(true);
  mounted.push(structuredClone(mounted.state));
  expect(group().open).toBe(true);
});

it('keeps project keyboard focus across activity repaint without taking composer focus or reloading on disclosure', async () => {
  const { project, session } = projectSidebarFixture();
  const listSessions = vi.fn(async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }), listSessions
  });
  const doc = mounted.window.document;
  const heading = () => doc.querySelector<HTMLElement>(`[data-project-id="${project.id}"] > summary`)!;
  await vi.waitFor(() => expect(heading()).not.toBeNull());
  await settle();
  const reads = listSessions.mock.calls.length;
  heading().focus(); heading().click();
  await settle();
  expect(listSessions).toHaveBeenCalledTimes(reads);
  expect(doc.activeElement).toBe(heading());
  mounted.push(structuredClone(mounted.state));
  expect(doc.activeElement).toBe(heading());
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.focus(); input.value = 'Keep typing here';
  mounted.push(structuredClone(mounted.state));
  expect(doc.activeElement).toBe(input);
  expect(input.value).toBe('Keep typing here');
  const { chatVisible } = await import('../src/renderer/chat.js');
  chatVisible(false); chatVisible(true);
  await settle();
  expect(listSessions).toHaveBeenCalledTimes(reads + 1);
});

it('keeps global connection controls in a compact sidebar popover', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  const now = Date.now();
  const connected = structuredClone(mounted.state) as any;
  connected.status = {
    state: 'connected', detail: 'Connected.', publicUrl: null, localUrl: 'http://127.0.0.1:1234',
    handshakeAt: now - 5_000, lastRequestAt: now - 3_000, lastToolCallAt: now - 2_000, health: null,
    surfaces: [{ id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
      available: true, localUrl: 'http://127.0.0.1:1234', publicUrl: null, tools: ['read'], state: 'live',
      detail: '', lastRequestAt: now - 3_000, lastToolCallAt: now - 2_000 }]
  };
  connected.bridge = { running: true, port: 8765, paired: true, present: true,
    lastSeenAt: now - 1_000, extensionVersion: '2.1.13' };
  mounted.push(connected);

  const trigger = doc.getElementById('sidebarConnection') as HTMLButtonElement;
  const popover = doc.getElementById('connectionPopover') as HTMLElement;
  expect(doc.querySelector('#chatTitle')!.closest('header')!.querySelector('#connectBtn')).toBeNull();
  expect(trigger.closest('.sidebar-bottom')).not.toBeNull();
  expect(trigger.textContent?.trim()).toBe('');
  expect(trigger.getAttribute('aria-label')).toMatch(/Connected.*verified/i);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');

  Object.defineProperty(mounted.window, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(mounted.window, 'innerHeight', { configurable: true, value: 760 });
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
    x: 200, y: 700, left: 200, top: 700, right: 236, bottom: 736, width: 36, height: 36,
    toJSON: () => ({})
  } as DOMRect);
  vi.spyOn(popover, 'getBoundingClientRect').mockReturnValue({ width: 160 } as DOMRect);
  trigger.click();
  expect(popover.hidden).toBe(false);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(popover.style.left).toBe('138px');
  expect(popover.parentElement).toBe(doc.body);
  expect(doc.getElementById('connectionPopoverSettings')).toBeNull();
  const advanced = doc.getElementById('connectionAdvanced') as HTMLDetailsElement;
  const runtime = doc.getElementById('connectionRuntime') as HTMLDetailsElement;
  advanced.open = runtime.open = true;
  trigger.click(); trigger.click();
  expect(advanced.open).toBe(false);
  expect(runtime.open).toBe(false);
  expect(doc.getElementById('connectionPopoverConnector')!.textContent).toMatch(/Reached/i);
  expect(doc.getElementById('connectionPopoverBrowser')!.textContent).toBe('Connected');
  expect(doc.getElementById('connectionPopoverBrowser')!.parentElement!.title).toMatch(/Seen/i);
  expect(doc.getElementById('connectionPopoverBrowser')!.classList.contains('sr-only')).toBe(true);
  expect(doc.getElementById('connectionPopoverBrowser')!.parentElement!.dataset.tone).toBe('ok');
  expect(doc.getElementById('connectionPopoverVerified')!.hidden).toBe(true);
  expect(doc.getElementById('connectionPopoverTitle')!.title).toMatch(/verified/i);
  expect(doc.getElementById('connectionPipeline')!.closest('details')).toBe(runtime);
  expect(doc.getElementById('connectionPopoverExtension')!.textContent).toBe('v2.1.13');
  expect((doc.getElementById('connectionPopoverToggle') as HTMLButtonElement).textContent).toBe('Disconnect');

  doc.body.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
  expect(popover.hidden).toBe(true);
});

it('keeps the Settings footer action visible while settings are open', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  const settings = doc.getElementById('workspaceSettings') as HTMLButtonElement;

  expect(settings.hidden).toBe(false);
  settings.click();
  expect(settings.hidden).toBe(false);
  expect(settings.classList.contains('is-sel')).toBe(true);
  (doc.getElementById('backToChat') as HTMLButtonElement).click();
  expect(settings.hidden).toBe(false);
  expect(settings.classList.contains('is-sel')).toBe(false);
});

it('renders companion diagnostics in the native Advanced connection drawer', async () => {
  const now = Date.now();
  const diagnostics = {
    capturedAt: now - 2_000,
    status: {
      connected: true, port: 8765, paired: true, disconnected: false,
      pending: 0, pendingCommandAcks: 0, compatible: true,
      appVersion: '2.1.13', appProtocol: 14, extensionVersion: '2.1.13', extensionProtocol: 14,
      pairError: null
    },
    preferences: { overwrite: true, durations: false },
    tab: {
      tab: 17, isChat: true, conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      bound: true, epoch: 4, terminal: false, recorder: true,
      page: {
        recorderVersion: 13, runId: 'run-live', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        generating: true, turnId: 'turn-current-long-id', generations: 2, queued: 0, queueBytes: 0,
        requestId: 'wfr_1234567890abcdef',
        trace: [{ requestId: 'wfr_1234567890abcdef', read: true, sent: true, confirmed: true, app: 'request_id', tool: 'read' }],
        overwrite: true, painted: true, events: 21, calls: 3, sends: 8, failures: 1,
        session: 'session-live', lastError: null, blocked: null
      },
      chatTabs: 2, pending: 0, pendingAll: 0, pendingCloses: 0, pendingCommandAcks: 0,
      delivery: { at: now - 1_000, ok: true, events: 4, total: 42, status: 200, error: null }
    }
  };
  const mounted = await mountChat({}, [], {
    companionDiagnostics: () => Promise.resolve({ ok: true, data: diagnostics }),
    browserPreferences: () => Promise.resolve({ ok: true, data: { overwrite: true, durations: false } })
  });
  const doc = mounted.window.document;
  const details = doc.getElementById('connectionAdvanced') as HTMLDetailsElement;
  details.open = true;
  details.dispatchEvent(new mounted.window.Event('toggle'));

  await vi.waitFor(() => expect(doc.getElementById('connectionAdvancedGrid')!.textContent).toContain('session-live'));
  expect(doc.getElementById('connectionAdvancedTab')!.classList.contains('is-ok')).toBe(true);
  expect(doc.getElementById('connectionAdvancedRequest')!.textContent).toContain('wfr_12345…cdef');
  expect(doc.getElementById('connectionAdvancedApp')!.textContent).toContain('tool matched');
  expect(doc.getElementById('connectionPipelineOwner')!.classList.contains('is-done')).toBe(true);
  expect(doc.getElementById('connectionAdvancedGrid')!.textContent).toContain('companion browser');
  expect(doc.getElementById('connectionAdvancedGrid')!.textContent).toContain('fiber v13 · run run-live');
});

it('uses Internal Chromium as the host source when the optional #237 API is present', async () => {
  const mounted = await mountChat({}, [], {
    internalBrowser: () => Promise.resolve({
      ok: true,
      data: {
        open: false,
        ready: true,
        tabId: 3,
        tabs: [
          { id: 1, active: false, status: 'complete', title: 'ChatGPT', url: 'https://chatgpt.com/' },
          { id: 3, active: true, status: 'complete', title: 'Current chat · ChatGPT',
            url: 'https://chatgpt.com/c/6aaa1c34-6bd0-83e9-9677-183c1030b86f' }
        ]
      }
    }),
    companionDiagnostics: () => Promise.resolve({ ok: true, data: null }),
    browserPreferences: () => Promise.resolve({ ok: true, data: { overwrite: true, durations: false } })
  });
  const doc = mounted.window.document;
  const details = doc.getElementById('connectionAdvanced') as HTMLDetailsElement;
  details.open = true;
  details.dispatchEvent(new mounted.window.Event('toggle'));

  await vi.waitFor(() => expect(doc.getElementById('connectionAdvancedGrid')!.textContent).toContain('Internal Chromium · ready'));
  expect(doc.getElementById('connectionAdvancedTab')!.textContent).toContain('#3 · complete');
  expect(doc.getElementById('connectionAdvancedRecording')!.textContent).toContain('companion pending');
  expect(doc.getElementById('connectionAdvancedChat')!.textContent).toContain('6aaa1c34…b86f');
  expect(doc.getElementById('connectionPipelineWhy')!.textContent).toContain('Internal Chromium is live');
});

it('always offers setup collapse and preserves the choice across incomplete status updates', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const button = doc.getElementById('wizExpand') as HTMLButtonElement;
  expect(button.hidden).toBe(false);
  button.click();
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(true);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  mounted.push({ ...mounted.state, hasApiKey: true });
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(true);
  button.click();
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(false);
});

it('adds and selects setup profiles and rejects an older profile status response', async () => {
  const add = vi.fn(); const select = vi.fn();
  const mounted = await mountChat({}, [], { addSetupProfile: add, selectSetupProfile: select });
  const doc = mounted.window.document;
  // jsdom does not implement native dialogs/popovers; Chromium acceptance covers their UI.
  const dialog = doc.getElementById('setupProfileDialog') as HTMLDialogElement;
  dialog.showModal = vi.fn(); dialog.close = vi.fn();
  doc.getElementById('setupProfileMenu')!.hidePopover = vi.fn();
  const initial = structuredClone(mounted.state);
  const next = { ...initial, config: { ...initial.config, tunnel: { ...initial.config.tunnel,
    profileId: 'second', profileName: 'Work', profileEpoch: 1, tunnelId: '' },
    setupProfiles: [{ id: 'default', name: 'Default', tunnelId: initial.config.tunnel.tunnelId, desktopTunnelId: '', pluginsTunnelId: '' }] } };
  add.mockResolvedValue({ ok: true, data: next });
  (doc.getElementById('setupProfileAdd') as HTMLButtonElement).click();
  expect(dialog.showModal).toHaveBeenCalled();
  (doc.getElementById('setupProfileName') as HTMLInputElement).value = 'Work';
  doc.getElementById('setupProfileForm')!.dispatchEvent(new mounted.window.Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(doc.getElementById('setupProfileCurrent')!.textContent).toBe('Work'));
  expect(add).toHaveBeenCalledWith('Work');
  expect((doc.getElementById('tunnelId') as HTMLInputElement).value).toBe('');
  mounted.push(initial);
  expect(doc.querySelector('[data-profile-id="second"]')!.getAttribute('aria-pressed')).toBe('true');
  select.mockResolvedValue({ ok: true, data: { ...initial, config: { ...initial.config, tunnel: {
    ...initial.config.tunnel, profileId: 'default', profileEpoch: 2 }, setupProfiles: [] } } });
  (doc.querySelector('[data-profile-id="default"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(select).toHaveBeenCalledWith('default'));
  await vi.waitFor(() => expect((doc.getElementById('tunnelId') as HTMLInputElement).value).toBe(initial.config.tunnel.tunnelId));
});

it('attaches pasted screenshot files with previews while preserving ordinary text paste', async () => {
  const dropFiles = vi.fn(async () => ({ ok: true, data: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'screenshot.png', size: 4, mimeType: 'image/png', preview: 'data:image/webp;base64,AAAA' }] }));
  const mounted = await mountChat({}, [], { dropFiles });
  const w = mounted.window, input = w.document.getElementById('settingsSearch') as HTMLInputElement;
  input.focus();
  const file = new w.File(['image'], 'screenshot.png', { type: 'image/png' });
  const paste = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
  input.dispatchEvent(paste);
  await vi.waitFor(() => expect(dropFiles).toHaveBeenCalledWith([file]));
  expect(paste.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(w.document.querySelector('img[src="data:image/webp;base64,AAAA"]')).not.toBeNull());
  const text = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(text, 'clipboardData', { value: { files: [] } });
  input.dispatchEvent(text);
  expect(text.defaultPrevented).toBe(false);
  expect(w.document.activeElement).toBe(input);
  const overflow = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(overflow, 'clipboardData', { value: { files: Array(20).fill(file) } });
  input.dispatchEvent(overflow);
  expect(overflow.defaultPrevented).toBe(true);
  expect(dropFiles).toHaveBeenCalledTimes(1);
});

it('saves the ChatGPT browser choice from its settings control and restores it on state push', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const browser = w.document.getElementById('chatBrowser') as HTMLSelectElement;
  expect(browser.value).toBe('chrome'); // older config has no field
  browser.value = 'edge';
  browser.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].ui.chatBrowser).toBe('edge');
  expect(browser.value).toBe('edge');
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, chatBrowser: 'chrome' } } });
  expect(browser.value).toBe('chrome');
});

it('shows the current host Desktop tools without rebuilding permission controls on state pushes', async () => {
  const mounted = await mountChat({
    platform: { family: 'windows', name: 'Windows', desktopAutomation: true }
  });
  const doc = mounted.window.document;
  const names = () => Array.from(doc.querySelectorAll('[data-group="desktop"] .tool-names code'), node => node.textContent);
  const control = doc.querySelector<HTMLInputElement>('[data-cap="control"]')!;
  const windowsNames = [...BROWSER_READ_TOOLS, 'list_windows', 'get_window', 'list_apps', 'get_window_state', ...BROWSER_WRITE_TOOLS,
    'launch_app', 'click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag',
    'perform_secondary_action', 'activate_window', 'read_clipboard', 'write_clipboard', 'exec'];
  expect(names()).toEqual(windowsNames);
  mounted.push({ ...mounted.state, platform: { family: 'macos', name: 'macOS', desktopAutomation: true } });
  expect(names()).toEqual([...BROWSER_READ_TOOLS, 'observe', ...BROWSER_WRITE_TOOLS, 'computer', 'exec']);
  expect(doc.querySelector('[data-cap="control"]')).toBe(control);
  mounted.push(mounted.state);
  expect(names()).toEqual(windowsNames);
  expect(mounted.calls).toHaveLength(0);
});

it('preserves native Desktop permissions when saving unrelated settings on Linux', async () => {
  const mounted = await mountChat({
    platform: { family: 'linux', name: 'Linux', desktopAutomation: false }
  });
  const w = mounted.window;

  const desktopGroup = w.document.querySelector<HTMLElement>('[data-group="desktop"]')!;
  expect(desktopGroup.hidden).toBe(false);
  expect(w.document.querySelector<HTMLInputElement>('[data-cap="control"]')!.disabled).toBe(false);
  expect(w.document.querySelector<HTMLInputElement>('[data-cap="clipboardWrite"]')!.disabled).toBe(true);

  const autoConnect = w.document.getElementById('autoConnect') as HTMLInputElement;
  autoConnect.checked = true;
  autoConnect.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();

  expect(mounted.calls).toHaveLength(1);
  expect(mounted.calls[0].ui.autoConnect).toBe(true);
  expect(mounted.calls[0].capabilities).toMatchObject({
    screen: true,
    control: true,
    clipboardRead: true,
    clipboardWrite: true
  });
});

it('uses native menu-bar/Dock wording on macOS instead of Windows tray copy', async () => {
  const mounted = await mountChat({
    platform: { family: 'macos', name: 'macOS', desktopAutomation: true }
  });
  const doc = mounted.window.document;

  expect(doc.getElementById('backgroundRunningCopy')!.textContent).toContain('menu bar and Dock');
  expect(doc.getElementById('backgroundRunningCopy')!.textContent).not.toContain('tray');
  expect(doc.getElementById('minimizeToTrayCopy')!.textContent).toBe('Hide the window to the menu bar when closed');
});

it('surfaces the existing root rename API in the folder row', async () => {
  const renames: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], {
    renameRoot: (name: string, newName: string) => {
      renames.push([name, newName]);
      return Promise.resolve({ ok: false, error: 'test stops before mutation' });
    }
  });
  const doc = mounted.window.document;
  const button = doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]');
  expect(button).not.toBeNull();

  button!.click();
  const input = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  input.value = 'New-Repo';
  input.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();

  expect(renames).toEqual([['repo', 'new-repo']]);
});

it('preserves an in-progress root rename across unrelated state pushes and cancels it if the root disappears', async () => {
  const renames: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], {
    renameRoot: (name: string, newName: string) => {
      renames.push([name, newName]);
      return Promise.resolve({ ok: false, error: 'rename failed for retry test' });
    }
  });
  const doc = mounted.window.document;
  doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]')!.click();

  const original = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  original.value = 'new-name';
  original.setSelectionRange(3, 7);

  const unrelated = structuredClone(mounted.state) as any;
  unrelated.status.detail = 'unrelated live status push';
  mounted.push(unrelated);

  const preserved = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  expect(preserved).not.toBeNull();
  expect(doc.activeElement).toBe(preserved);
  expect(preserved.value).toBe('new-name');
  expect(preserved.selectionStart).toBe(3);
  expect(preserved.selectionEnd).toBe(7);

  preserved.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(renames).toEqual([['repo', 'new-name']]);
  const retry = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  expect(retry.value).toBe('new-name');
  retry.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(renames).toEqual([['repo', 'new-name'], ['repo', 'new-name']]);

  const escape = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  escape.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(doc.querySelector('.root-rename')).toBeNull();

  doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]')!.click();
  expect(doc.querySelector('.root-rename')).not.toBeNull();

  const removed = structuredClone(unrelated) as any;
  removed.config.roots = [];
  mounted.push(removed);
  expect(doc.querySelector('.root-rename')).toBeNull();
  expect(doc.querySelector('.root')).toBeNull();
});

it('guides rootless setup from the capabilities that actually need a filesystem root', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const mixed = structuredClone(mounted.state) as any;
  mixed.hasApiKey = true;
  mixed.config.roots = [];
  mixed.config.readOnly = false;
  for (const capability of Object.keys(mixed.config.capabilities)) mixed.config.capabilities[capability] = false;
  mixed.config.capabilities.browse = true;
  mixed.config.capabilities.screen = true;
  mixed.status.surfaces = [
    {
      id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
      available: true, localUrl: null, publicUrl: null, tools: ['read'], state: 'off', detail: '',
      lastRequestAt: null, lastToolCallAt: null
    },
    {
      id: 'desktop', connectorName: 'Desktop', description: '', cardSummary: '', optional: true,
      available: true, localUrl: null, publicUrl: null, tools: ['observe'], state: 'off', detail: '',
      lastRequestAt: null, lastToolCallAt: null
    }
  ];

  mounted.push(mixed);
  const connect = mounted.window.document.getElementById('connectionPopoverToggle') as HTMLButtonElement;
  expect(connect.disabled).toBe(true);
  expect(connect.title).toContain('Choose a folder');
  expect(mounted.window.document.querySelector('[data-step="folder"]')?.classList.contains('is-current')).toBe(true);

  const commandAndDesktop = structuredClone(mixed) as any;
  commandAndDesktop.config.capabilities.browse = false;
  commandAndDesktop.config.capabilities.command = true;
  mounted.push(commandAndDesktop);
  expect(connect.disabled).toBe(true);
  expect(connect.title).toContain('Choose a folder');

  const desktopOnly = structuredClone(mixed) as any;
  desktopOnly.config.capabilities.browse = false;
  mounted.push(desktopOnly);
  expect(connect.disabled).toBe(false);
  expect(connect.title).toBe('');

  const clipboardOnly = structuredClone(desktopOnly) as any;
  clipboardOnly.config.capabilities.screen = false;
  clipboardOnly.config.capabilities.clipboardRead = true;
  clipboardOnly.status.surfaces[1].tools = ['computer'];
  mounted.push(clipboardOnly);
  expect(connect.disabled).toBe(false);
});

it('preserves optional Desktop disclosures and inline screenshots across status pushes', async () => {
  const mounted = await mountChat();
  const state = structuredClone(mounted.state) as any;
  state.status.surfaces = [{
    id: 'desktop', connectorName: 'Desktop', description: 'Desktop control', cardSummary: '', optional: true,
    available: true, localUrl: null, publicUrl: null, tools: ['observe'], state: 'off', detail: '',
    lastRequestAt: null, lastToolCallAt: null
  }];
  mounted.push(state);
  const doc = mounted.window.document;
  const field = doc.getElementById('desktopTunnelField') as HTMLDetailsElement;
  const card = () => doc.querySelector<HTMLDetailsElement>('#connectorCards details')!;
  expect(field.hidden).toBe(false);
  expect(field.open).toBe(false);
  expect(card().open).toBe(false);
  field.querySelector('summary')!.click(); card().querySelector('summary')!.click();
  const guide = doc.querySelector('[data-setup-guide="tunnel"]')!;
  expect(guide.querySelectorAll('img')).toHaveLength(1);
  expect(doc.querySelectorAll('[data-setup-guide="developer"] img')).toHaveLength(1);
  expect(doc.querySelectorAll('[data-setup-guide="plugin"] img')).toHaveLength(2);
  const image = guide.querySelector('img')!;
  mounted.push(structuredClone(state));
  expect(field.open).toBe(true);
  expect(card().open).toBe(true);
  expect(guide.querySelector('img')).toBe(image);
  expect(image.src).toContain('workspace.png');
  expect(mounted.calls).toEqual([]);
  card().querySelector('summary')!.click();
  mounted.push(structuredClone(state));
  expect(card().open).toBe(false);
  expect(field.open).toBe(true);
});

it('highlights missing required setup fields while respecting drafts and a stored API key', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const tunnel = doc.getElementById('tunnelId') as HTMLInputElement;
  const key = doc.getElementById('apiKey') as HTMLInputElement;
  expect(tunnel.classList.contains('is-empty')).toBe(false);
  expect(key.classList.contains('is-empty')).toBe(true);
  expect(doc.getElementById('desktopTunnelId')!.classList.contains('setup-required')).toBe(false);

  tunnel.focus();
  tunnel.value = '  ';
  tunnel.dispatchEvent(new mounted.window.Event('input'));
  expect(tunnel.classList.contains('is-empty')).toBe(true);
  mounted.push(structuredClone(mounted.state));
  expect(tunnel.value).toBe('  ');
  expect(tunnel.classList.contains('is-empty')).toBe(true);
  tunnel.value = 'tunnel_draft';
  tunnel.dispatchEvent(new mounted.window.Event('input'));
  expect(tunnel.classList.contains('is-empty')).toBe(false);

  key.value = 'example-draft';
  key.dispatchEvent(new mounted.window.Event('input'));
  expect(key.classList.contains('is-empty')).toBe(false);
  key.value = '';
  key.dispatchEvent(new mounted.window.Event('input'));
  expect(key.classList.contains('is-empty')).toBe(true);
  mounted.push({ ...structuredClone(mounted.state), hasApiKey: true });
  expect(key.classList.contains('is-empty')).toBe(false);
  expect(key.getAttribute('aria-required')).toBe('false');
  mounted.push({ ...structuredClone(mounted.state), hasApiKey: false });
  expect(key.classList.contains('is-empty')).toBe(true);
  expect(mounted.keys).toEqual([]);
  expect(mounted.calls).toEqual([]);
});

it('keeps folder access discoverable after setup and navigates without granting access', async () => {
  const addRoot = vi.fn();
  const mounted = await mountChat({ hasApiKey: true }, [], { addRoot });
  const connected = structuredClone(mounted.state);
  connected.status.state = 'connected';
  connected.status.lastRequestAt = Date.now();
  connected.bridge.present = true;
  mounted.push(connected);
  const doc = mounted.window.document;
  const styles = doc.createElement('style');
  styles.textContent = await fs.readFile(path.join(process.cwd(), 'src/renderer/styles.css'), 'utf8');
  doc.head.append(styles);
  doc.querySelector<HTMLButtonElement>('[data-tab="setup"]')!.click();

  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(true);
  const manage = doc.getElementById('wizManageFolders')!;
  expect(mounted.window.getComputedStyle(manage.parentElement!).display).not.toBe('none');
  expect(doc.getElementById('wizFolders')!.textContent).toBe('/repo');
  manage.click();

  expect(doc.querySelector('.panel.is-active')?.getAttribute('data-panel')).toBe('home');
  expect(doc.activeElement).toBe(doc.getElementById('addFolder'));
  expect(doc.getElementById('rootList')!.textContent).toContain('/repo');
  expect(addRoot).not.toHaveBeenCalled();
  expect(mounted.calls).toEqual([]);
});

it('always requires the live browser because recording is an invariant', async () => {
  const mounted = await mountChat({
    hasApiKey: true,
    status: {
      state: 'connected',
      detail: 'Connected.',
      publicUrl: null,
      localUrl: 'http://127.0.0.1:1234',
      handshakeAt: Date.now(),
      lastRequestAt: Date.now(),
      lastToolCallAt: Date.now(),
      health: null,
      surfaces: [
        {
          id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
          available: true, localUrl: 'http://127.0.0.1:1234', publicUrl: null, tools: ['read', 'update_plan'],
          state: 'live', detail: '', lastRequestAt: Date.now(), lastToolCallAt: Date.now()
        }
      ]
    },
    // The token survived, but this process has not heard from the extension. This is the
    // disabled/uninstalled-extension-after-app-restart repro.
    bridge: { running: true, port: 8765, paired: true, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  });
  const doc = mounted.window.document;
  const browserStep = doc.querySelector<HTMLElement>('[data-step="browser"]')!;

  expect(browserStep.classList.contains('is-done')).toBe(false);
  expect(browserStep.classList.contains('is-current')).toBe(true);
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(false);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('Authorized');
  expect(doc.getElementById('bridgeState')!.textContent).not.toContain('Connected.');

  const live = structuredClone(mounted.state) as any;
  live.hasApiKey = true;
  live.status = (mounted.state as any).status;
  live.bridge = { running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now() };
  mounted.push(live);
  expect(browserStep.classList.contains('is-done')).toBe(true);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('Connected.');

  // Even a legacy/hand-built renderer snapshot cannot turn recording off. Main normalizes this
  // shape before publication; the renderer's setup predicate still fails closed if it sees one.
  const browserFree = structuredClone(live) as any;
  browserFree.config.sessions.record = false;
  browserFree.config.multiAgent.enabled = false;
  browserFree.config.capabilities.screen = false;
  browserFree.config.capabilities.control = false;
  browserFree.bridge = { running: false, port: null, paired: true, present: false, lastSeenAt: Date.now() };
  mounted.push(browserFree);
  expect(browserStep.hidden).toBe(false);
  expect(browserStep.classList.contains('is-current')).toBe(true);
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(false);
  expect(doc.getElementById('bridgeState')!.textContent).not.toContain('not needed');
});

/**
 * "Up to date" is a claim, and a claim needs somebody to have checked.
 *
 * Before GitHub answers, `{latest: null, stage: 'idle'}` means only that nothing has been
 * established - the same record a check that never ran would leave - so the Activity line stays
 * empty and no notification is shown. The timestamp is what turns that silence into an answer.
 */
it('says nothing about being current until the check has actually answered', async () => {
  const mounted = await mountChat({
    bridge: { running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.2' }
  });
  const doc = mounted.window.document;
  const line = doc.getElementById('updateLine')!;
  expect(line.hidden).toBe(true);
  expect(doc.querySelector('.toast')).toBeNull();

  const checked = structuredClone(mounted.state) as any;
  checked.update.checkedAt = Date.now();
  mounted.push(checked);

  // Green, both versions, and the same sentence as the one notification this window shows.
  expect(line.hidden).toBe(false);
  expect(line.className).toBe('upline is-ok');
  expect(line.textContent).toBe('Up to date! ShadowTools 2.0.2 · extension 2.0.2');
  expect(doc.querySelector('.toast')!.textContent).toBe(line.textContent);
  // Nothing to act on, so the header bar stays out of the way.
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);

  // The news is told once. A later push of the same fact repaints the line and nothing else.
  doc.querySelector('.toast')!.remove();
  mounted.push(structuredClone(checked) as any);
  expect(doc.querySelector('.toast')).toBeNull();
  expect(line.textContent).toBe('Up to date! ShadowTools 2.0.2 · extension 2.0.2');
});

/**
 * A staged update is not "up to date", and it is not a failure either.
 */
it('reports a staged update in the Activity line and the header bar', async () => {
  const mounted = await mountChat();
  const staged = structuredClone(mounted.state) as any;
  staged.update = { current: '2.0.2', latest: '2.0.3', stage: 'ready', error: null, checkedAt: Date.now() };
  mounted.push(staged);

  const doc = mounted.window.document;
  const line = doc.getElementById('updateLine')!;
  expect(line.className).toBe('upline');
  expect(line.textContent).toContain('2.0.3 is downloaded and ready');
  expect(doc.getElementById('updateNotice')!.hidden).toBe(false);
  // There is nothing to fetch by hand once it is on disk.
  expect((doc.getElementById('updateGet') as HTMLButtonElement).hidden).toBe(true);
  // ...and this is the one state in which there is something to install. Both buttons show,
  // because a tray app closed to the tray may not see the header for days.
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(false);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(false);

  const checking = structuredClone(staged) as any;
  checking.update.stage = 'checking';
  mounted.push(checking);
  expect(line.textContent).toContain('Checking for the latest update');
  expect(line.textContent).not.toContain('by hand');
  expect((doc.getElementById('updateGet') as HTMLButtonElement).hidden).toBe(true);
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(true);
  // Still downloading is not yet installable: there is no verified file to hand over.
  const downloading = structuredClone(staged) as any;
  downloading.update = { ...downloading.update, stage: 'downloading' };
  mounted.push(downloading);
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(true);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(true);

  const broken = structuredClone(staged) as any;
  broken.update = { current: '2.0.2', latest: null, stage: 'failed', error: 'latest answered 503', checkedAt: null };
  mounted.push(broken);
  expect(line.className).toBe('upline is-bad');
  expect(line.textContent).toContain('503');
  // A check that could not reach GitHub is a diagnostic, not something the user can act on.
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(true);
});

/**
 * The version difference has a direction, and only one of them is the user's to act on.
 *
 * An extension newer than the app is the ordinary state while an app update is downloading, and
 * the bundled folder is then the older copy: "load the extension folder again" would talk that
 * user into downgrading a working extension. The app-update line already owns being behind.
 */
it('asks for an extension reload only when the extension is older than this app', async () => {
  const mounted = await mountChat({
    bridge: {
      running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.1'
    }
  });
  const doc = mounted.window.document;
  const notice = doc.getElementById('updateNotice')!;
  expect(notice.hidden).toBe(false);
  expect(doc.getElementById('updateText')!.textContent).toContain('2.0.1');
  const action = doc.getElementById('updateExtension') as HTMLButtonElement;
  expect(action.hidden).toBe(false);
  action.click();
  expect(doc.querySelector('[data-panel="setup"]')!.classList.contains('is-active')).toBe(true);
  const rejected = structuredClone(mounted.state) as any;
  rejected.bridge.present = false;
  mounted.push(rejected);
  expect(notice.hidden, 'an old companion rejected by the protocol gate still needs an update').toBe(false);

  const ahead = structuredClone(mounted.state) as any;
  ahead.bridge.extensionVersion = '2.0.3';
  mounted.push(ahead);
  expect(notice.hidden, 'a newer extension is not a downgrade prompt').toBe(true);
  expect(action.hidden).toBe(true);
});

it('shows a missing-extension reminder while connected and clears it after the companion reports in', async () => {
  const mounted = await mountChat();
  const connected = structuredClone(mounted.state) as any;
  connected.status.state = 'connected'; connected.bridge.running = true; connected.bridge.present = false;
  mounted.push(connected);
  const doc = mounted.window.document;
  expect(doc.getElementById('updateText')!.textContent).toContain('Browser extension not connected');
  expect(doc.getElementById('updateExtension')!.hidden).toBe(false);
  connected.bridge.present = true; connected.bridge.extensionVersion = connected.update.current;
  mounted.push(connected);
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);
});

it('keeps plugin connection controls out of general Setup and preserves its tunnel during unrelated saves', async () => {
  const mounted = await mountChat(); const doc = mounted.window.document;
  const next = structuredClone(mounted.state); next.config.tunnel.pluginsTunnelId = 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  mounted.push(next);
  expect(doc.querySelector('[data-panel="setup"] #pluginsTunnelId')).toBeNull();
  const input = doc.getElementById('tunnelId') as HTMLInputElement;
  input.value = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  input.dispatchEvent(new mounted.window.Event('change')); await settle();
  expect(mounted.calls.at(-1).tunnel.pluginsTunnelId).toBe(next.config.tunnel.pluginsTunnelId);
  expect(doc.querySelector('[data-panel="setup"] [data-link="https://chatgpt.com/plugins"]')).not.toBeNull();
});

it('gives twenty rapid New Chat sends independent visible local chats before any provider receipt', async () => {
  const rows: any[] = [], summaries: any[] = [];
  const ok = (data: any) => ({ ok: true, data });
  const sendInput = vi.fn(async (request: any) => {
    const row = { ...request, sessionId: request.id, opening: true, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    rows.push(row);
    summaries.push({ id: row.sessionId, title: row.text, conversationId: null, origin: { kind: 'desktop' }, createdAt: row.createdAt, updatedAt: row.createdAt, eventCount: 0, projectId: null, selectedModel: null, usage: {} });
    return ok(row);
  });
  const mounted = await mountChat({}, [], { sendInput,
    getChatModels: async () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }] }),
    listInputs: async () => ok([...rows]), listPausedHelpers: async () => ok([]),
    listSessions: async () => ok({ sessions: [...summaries], activeId: null, pressure: [] }),
    getSession: async (id: string) => ok({ summary: summaries.find(row => row.id === id), events: [], nextCursor: null })
  });
  const w = mounted.window, doc = w.document, field = doc.getElementById('chatInput') as HTMLTextAreaElement;
  for (let index = 0; index < 20; index++) {
    (doc.getElementById('newChat') as HTMLButtonElement).click(); await settle();
    field.value = `Independent opening ${index}`;
    doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(index + 1));
    await vi.waitFor(() => expect(doc.querySelector(`.sess.is-sel[data-id="${rows[index]!.sessionId}"]`)).not.toBeNull());
    expect(doc.querySelector(`[data-input-id="${rows[index]!.id}"]`)?.textContent).toContain(rows[index]!.text);
    expect((doc.getElementById('composerModel') as HTMLSelectElement).value).toBe('gpt-5.6-sol');
  }
  expect(new Set(rows.map(row => row.sessionId)).size).toBe(20);
  expect(rows.every(row => row.state === 'queued' && row.deliveredAt === undefined)).toBe(true);
  expect(sendInput.mock.calls.every(([request]) => request.sessionId === null)).toBe(true);
});

it('does not steal a newer New Chat draft when an older admission response arrives', async () => {
  let release!: (value: any) => void;
  const rows: any[] = [], summaries: any[] = [];
  const ok = (data: any) => ({ ok: true, data });
  const sendInput = vi.fn((request: any) => new Promise(resolve => { release = () => {
    const row = { ...request, sessionId: request.id, opening: true, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    rows.push(row); summaries.push({ id: row.sessionId, title: row.text, conversationId: null, origin: { kind: 'desktop' }, createdAt: row.createdAt, updatedAt: row.createdAt, eventCount: 0, projectId: null, usage: {} });
    resolve(ok(row));
  }; }));
  const mounted = await mountChat({}, [], { sendInput,
    getChatModels: async () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }] }),
    listInputs: async () => ok([...rows]), listPausedHelpers: async () => ok([]),
    listSessions: async () => ok({ sessions: [...summaries], activeId: null, pressure: [] }),
    getSession: async (id: string) => ok({ summary: summaries.find(row => row.id === id), events: [], nextCursor: null })
  });
  const w = mounted.window, doc = w.document, field = doc.getElementById('chatInput') as HTMLTextAreaElement;
  (doc.getElementById('newChat') as HTMLButtonElement).click(); await settle();
  field.value = 'Old admission'; doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
  (doc.getElementById('newChat') as HTMLButtonElement).click(); field.value = 'Keep this newer draft';
  field.dispatchEvent(new w.Event('input', { bubbles: true })); release(undefined); await settle(); await settle();
  expect(field.value).toBe('Keep this newer draft');
  expect(doc.querySelector('.sess.is-sel')).toBeNull();
  expect(doc.getElementById('chatTitle')!.textContent).toBe('New chat');
});
