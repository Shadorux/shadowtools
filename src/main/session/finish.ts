import { getConfig } from '../config.js';
import { currentCall } from '../mcp/call-context.js';
import { getSession } from './store.js';
import { onSessionChange, recordProgress } from './recorder.js';
import { isChatBlocked } from './blocked-chats.js';
import { hasEligibleToolInput, finishNeedsBrowserInput, onInputChange, listInputs } from './input.js';

let notify: ((title: string, body: string, sessionId: string, turnId: string) => boolean | void) | null = null;
export function setFinishNotifier(listener: typeof notify): void { notify = listener; }
const finishCalls = new Map<string, number>();
export function sessionFinishDeadline(startedAt: number): number {
  return startedAt + 25_000;
}
export async function sessionFinishWaiting(sessionId: string, turnId: string | null | undefined, conversationId: string | null): Promise<boolean> {
  return !!turnId && finishCalls.has(`${sessionId}:${turnId}`) &&
    await sessionFinishHeld(sessionId, turnId, conversationId) &&
    !(await listInputs()).some(entry => entry.sessionId === sessionId && ['queued', 'browser', 'tool'].includes(entry.state));
}
/** Record and notify once for the exact active turn, without generating follow-ups. */
async function prepareNotice(sessionId: string, summary: string): Promise<string> {
  const session = await getSession(sessionId);
  const call = currentCall();
  const turnId = session?.activeTurnId;
  if (!session?.conversationId || !turnId || call?.caller.sessionId !== sessionId || call.caller.conversationId !== session.conversationId)
    throw new Error('Session finish requires this caller\'s exact active session and turn');
  if (!(await sessionFinishHeld(sessionId, turnId, session.conversationId))) return 'The finish hold is no longer active.';
  if (session.finishTurn?.notified) return 'The finish notice was already requested.';
  const anchor = await recordProgress(sessionId, `finish:${turnId}`, `Preparing finish notice: ${summary.trim().slice(0, 1000)}`,
    undefined, turnId, { state: 'notified', conversationId: session.conversationId });
  if (!anchor) throw new Error('Finish notice could not be recorded');
  if (!(await sessionFinishHeld(sessionId, turnId, session.conversationId))) return 'The turn changed before notification.';
  try { notify?.('Astra is wrapping up', 'Write your next instruction or end the turn.', sessionId, turnId); }
  catch { return 'The desktop notification could not be shown.'; }
  return 'Finish notice recorded. Process any user input attached to this result.';
}

/** Release is an app-authored fact in the existing transcript, scoped to exact turn + frontend. */
export async function sessionFinishHeld(sessionId: string, turnId: string | null | undefined, conversationId: string | null): Promise<boolean> {
  if (!getConfig().ui.finishTool || !turnId || !conversationId || isChatBlocked(conversationId)) return false;
  return !(await finishReleased(sessionId, turnId, conversationId));
}
async function finishReleased(sessionId: string, turnId: string, conversationId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  const finish = session?.finishTurn;
  if (session?.activeTurnId !== turnId || session.conversationId !== conversationId) return true;
  if (finish?.turnId !== turnId) throw new Error('This turn’s finish authority could not be recovered');
  return finish.conversationId === conversationId && finish.released;
}
export async function releaseSessionFinish(sessionId: string, expectedTurnId: string, reason: 'end' | 'stop' = 'end'): Promise<void> {
  const session = await getSession(sessionId);
  if (!session?.conversationId || session.activeTurnId !== expectedTurnId) throw new Error('The active turn changed; refresh before ending it');
  if (await finishReleased(sessionId, expectedTurnId, session.conversationId)) return;
  const latest = await getSession(sessionId);
  if (latest?.activeTurnId !== expectedTurnId || latest.conversationId !== session.conversationId) throw new Error('The active turn changed; refresh before ending it');
  const message = reason === 'stop'
    ? 'Stop requested. The finish hold was released; ChatGPT has not yet confirmed that generation stopped.'
    : 'Finish hold released. ChatGPT may finish its answer; generation has not been stopped.';
  const receipt = await recordProgress(sessionId, `finish-release:${expectedTurnId}`, message,
    undefined, expectedTurnId, { state: 'released', conversationId: session.conversationId });
  if (!receipt) throw new Error('End turn could not be saved; this turn remains held');
}

/** One bounded transport wait. Event subscriptions observe; only the kernel consumes input. */
async function waitForFinishBoundary(sessionId: string, turnId: string, conversationId: string, remainingMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let closed = false;
    let checking = false;
    let dirty = false;
    const done = (held: boolean, error?: unknown) => {
      if (closed) return;
      closed = true; clearTimeout(timer); stopInput(); stopSession();
      if (error) reject(error); else resolve(held);
    };
    const check = async () => {
      if (closed) return;
      if (checking) { dirty = true; return; }
      checking = true;
      try {
        do {
          dirty = false;
          const session = await getSession(sessionId);
          if (session?.activeTurnId !== turnId || session.conversationId !== conversationId ||
              !(await sessionFinishHeld(sessionId, turnId, conversationId))) return done(false);
          if (await hasEligibleToolInput(sessionId, true)) return done(true);
          if (await finishNeedsBrowserInput(sessionId)) {
            await releaseSessionFinish(sessionId, turnId);
            return done(false);
          }
        } while (dirty && !closed);
      } catch (error) { done(false, error); }
      finally { checking = false; }
    };
    const stopInput = onInputChange(() => { void check(); });
    const stopSession = onSessionChange(() => { void check(); });
    const timer = setTimeout(() => {
      void (async () => {
        const session = await getSession(sessionId);
        done(session?.activeTurnId === turnId && session.conversationId === conversationId &&
          await sessionFinishHeld(sessionId, turnId, conversationId));
      })().catch(error => done(false, error));
    }, Math.max(0, remainingMs));
    void check();
  });
}

/** HELD is a model instruction, not a server-side lock on ChatGPT finalization. */
export async function announceSessionFinish(sessionId: string, summary: string, deadline = sessionFinishDeadline(Date.now())): Promise<string> {
  const session = await getSession(sessionId);
  const call = currentCall();
  if (!session?.activeTurnId || !session.conversationId || call?.caller.sessionId !== sessionId ||
      call.caller.conversationId !== session.conversationId) throw new Error('Session finish requires this caller’s exact active session and turn');
  if (session.finishTurn?.turnId !== session.activeTurnId || session.finishTurn.startedAt > call.startedAt)
    throw new Error('The active turn changed or its start could not be verified');
  const key = `${sessionId}:${session.activeTurnId}`;
  finishCalls.set(key, (finishCalls.get(key) ?? 0) + 1);
  try {
    const queued = (await listInputs()).some(entry => entry.sessionId === sessionId && ['queued', 'browser', 'tool'].includes(entry.state));
    const notice = queued ? 'Queued user instructions are ready.' : await prepareNotice(sessionId, summary);
    const held = await waitForFinishBoundary(sessionId, session.activeTurnId, session.conversationId, deadline - Date.now());
    return held
      ? `HELD: Keep this turn open. Complete and verify the remaining requested work, including attached instructions, before calling session_finish again. New messages and progress updates are not finish checkpoints. If no requested work remains, wait here with session_finish; do not invent work. The user can stop generation with the composer Stop button.\n${notice}`
      : `RELEASED: This hold has ended or its turn changed. Do not repeat the hold; follow the latest user instruction. This is not confirmation that provider generation stopped.\n${notice}`;
  } finally {
    const remaining = (finishCalls.get(key) ?? 1) - 1;
    if (remaining) finishCalls.set(key, remaining); else finishCalls.delete(key);
  }
}
