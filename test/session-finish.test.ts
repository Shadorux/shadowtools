import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { appendEvent, createSession, getSession, initSessionStore, readRecentEvents, resetSessionStoreForTests } from '../src/main/session/store.js';
import { announceSessionFinish, releaseSessionFinish, sessionFinishHeld, setFinishNotifier } from '../src/main/session/finish.js';
import { resetRecorderForTests } from '../src/main/session/recorder.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const hooks = vi.hoisted(() => ({
  caller: { sessionId: '', conversationId: '' },
  startedAt: 2000,
  hasInput: true,
  browserInput: false,
  inputs: [] as Array<{ sessionId: string | null; state: string }>,
  listeners: new Set<() => void>()
}));

vi.mock('../src/main/mcp/call-context.js', async original => ({
  ...await original<object>(),
  currentCall: () => ({ caller: { ...hooks.caller }, startedAt: hooks.startedAt })
}));
vi.mock('../src/main/session/input.js', () => ({
  hasEligibleToolInput: async () => hooks.hasInput,
  finishNeedsBrowserInput: async () => hooks.browserInput,
  listInputs: async () => hooks.inputs,
  onInputChange: (listener: () => void) => { hooks.listeners.add(listener); return () => hooks.listeners.delete(listener); }
}));

let directory = '';
let sessionId = '';
let conversationId = '';
const notify = vi.fn();

beforeAll(async () => {
  directory = await makeTempDir('clf-session-finish-');
  initConfigPath(directory);
  initSessionStore(directory);
});

beforeEach(async () => {
  hooks.hasInput = true;
  hooks.browserInput = false;
  hooks.inputs = [];
  hooks.listeners.clear();
  notify.mockReset();
  setFinishNotifier(notify);
  const config = defaultConfig();
  await saveConfig({ ...config, sessions: { ...config.sessions, record: true }, ui: { ...config.ui, finishTool: true } });
  conversationId = randomUUID();
  const session = await createSession({ conversationId, title: 'Finish test' });
  sessionId = session.id;
  hooks.caller = { sessionId, conversationId };
  hooks.startedAt = 2000;
  await appendEvent(sessionId, { source: 'extension', kind: 'turn_start', turnId: 'turn-one', time: 1000 });
});

afterEach(() => {
  resetRecorderForTests();
  vi.restoreAllMocks();
});

afterAll(async () => {
  setFinishNotifier(null);
  resetSessionStoreForTests();
  await removeTempDir(directory);
});

it('records one notice and holds the exact active turn without generating follow-ups', async () => {
  const first = await announceSessionFinish(sessionId, 'Final verification');
  const second = await announceSessionFinish(sessionId, 'Final verification again');
  expect(first).toContain('HELD:');
  expect(second).toContain('HELD:');
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith('Astra is wrapping up', expect.any(String), sessionId, 'turn-one');
  expect(await sessionFinishHeld(sessionId, 'turn-one', conversationId)).toBe(true);
});

it('gives already queued user work priority without publishing another notice', async () => {
  hooks.inputs = [{ sessionId, state: 'queued' }];
  const result = await announceSessionFinish(sessionId, 'Ready');
  expect(result).toContain('HELD:');
  expect(result).toContain('Queued user instructions are ready.');
  expect(notify).not.toHaveBeenCalled();
});

it('releases the exact hold with a durable end receipt', async () => {
  await releaseSessionFinish(sessionId, 'turn-one');
  expect(await sessionFinishHeld(sessionId, 'turn-one', conversationId)).toBe(false);
  const progress = await readRecentEvents(sessionId, 20, { kinds: ['progress'] });
  expect(progress).toContainEqual(expect.objectContaining({
    progressId: 'finish-release:turn-one',
    message: expect.objectContaining({ text: 'Finish hold released. ChatGPT may finish its answer; generation has not been stopped.' })
  }));
  expect((await getSession(sessionId))?.activeTurnId).toBe('turn-one');
});

it('releases instead of generating work when an after-turn browser input owns the boundary', async () => {
  hooks.hasInput = false;
  hooks.browserInput = true;
  const result = await announceSessionFinish(sessionId, 'Ready');
  expect(result).toContain('RELEASED:');
  expect(await sessionFinishHeld(sessionId, 'turn-one', conversationId)).toBe(false);
});

it('refuses a caller that does not own the active session', async () => {
  hooks.caller = { sessionId: randomUUID(), conversationId };
  await expect(announceSessionFinish(sessionId, 'Wrong owner')).rejects.toThrow('exact active session and turn');
});
