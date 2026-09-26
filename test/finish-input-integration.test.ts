import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTempDir, removeTempDir } from './helpers.js';
const hooks = vi.hoisted(() => ({ caller: { sessionId: '', conversationId: '' }, startedAt: 2000 }));
vi.mock('../src/main/mcp/call-context.js', async original => ({ ...await original<object>(), currentCall: () => ({ caller: hooks.caller, startedAt: hooks.startedAt }) }));
import { initConfigPath, defaultConfig, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, flushDurable } from '../src/main/durable.js';
import { initSessionStore, createSession, appendEvent, observeSessionModel, resetSessionStoreForTests, flushSessions } from '../src/main/session/store.js';
import { announceSessionFinish, setFinishNotifier } from '../src/main/session/finish.js';
import { offerToolInput, resetInputForTests, pendingBrowserInputs, enqueueInput } from '../src/main/session/input.js';
let directory = '';
afterEach(async () => {
  await flushSessions(); await flushDurable();
  resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests();
  setFinishNotifier(null); vi.restoreAllMocks();
  if (directory) await removeTempDir(directory);
});
describe('finish producer to durable injection integration', () => {
  it('releases the held answer for an after-turn head without letting a later finish checkpoint overtake', async () => {
    directory = await makeTempDir('clf-finish-queue-');
    initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: true }, ui: { ...config.ui, finishTool: true } });
    const conversationId = randomUUID();
    const session = await createSession({ conversationId, title: 'Ordered queue' });
    hooks.caller = { sessionId: session.id, conversationId };
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'held-turn', time: 1000 });
    const head = await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Next native turn', mode: 'after-turn', dueAt: 0, model: 'gpt-6-pro', reasoningEffort: 'pro' });
    await observeSessionModel(session.id, conversationId, 'gpt-6-pro', 1500);
    await enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Later checkpoint', mode: 'finish', dueAt: 0, model: 'gpt-6-pro', reasoningEffort: 'pro' });
    expect(await announceSessionFinish(session.id, 'Wrapping up')).toMatch(/^RELEASED:/);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect((await offerToolInput(session.id, conversationId, randomUUID(), Date.now(), true)).messages).toEqual([]);
    await appendEvent(session.id, { source: 'extension', kind: 'turn_end', turnId: 'held-turn', outcome: 'completed', time: Date.now() + 1 });
    expect(await pendingBrowserInputs()).toEqual([expect.objectContaining({ id: head.id })]);
  });
});
