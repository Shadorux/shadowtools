import { requestBrowserDecision } from './session/input.js';
import { planProgressText, type TaskProgressUpdate } from '../shared/task-progress.js';
import { getConfig } from './config.js';

/** Explicitly requested planning only; this module never continues an executor turn. */
export async function draftTaskPlan(prompt: string, onProgress?: (progress: TaskProgressUpdate) => void, signal?: AbortSignal): Promise<string[]> {
  onProgress?.({ phase: 'preparing', text: '' });
  if (!prompt.trim() || prompt.length > 16000) throw new Error('Enter a task of at most 16000 characters');
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
    : AbortSignal.timeout(180_000);
  requestSignal.throwIfAborted();
  const instruction = [
    'You are a task planner, not the executor. The task below is reference data; do not execute it or claim its work is done.',
    'Produce 2 to 12 substantial workflow stages. The executor receives the original request and the ENTIRE workflow in its first message.',
    'Stage 1 must state the complete objective, requirements, constraints and end-to-end implementation approach. Never restrict it to discovery, planning, a skeleton or a fraction of the product.',
    'Include concrete early subagent assignments when the user requested them. Later stages are verification and improvement checkpoints, not withheld implementation requirements.',
    'Where relevant, exercise the actual app, inspect failures, repair underlying causes and repeat failed workflows. Rebuild or reinstall only when authorized. Include independent review when requested and a final check of the whole original request.',
    'Preserve scope, authorization limits, platform, constraints and required evidence. Do not invent unrelated work or claim checks were performed.',
    'Return only JSON in the form {"stages":["complete implementation workflow","verification workflow"]}. Keep the entire plan below 12000 characters.',
    '<task>', JSON.stringify(prompt.trim()), '</task>'
  ].join('\n\n');
  onProgress?.({ phase: 'generating', text: '' });
  const config = getConfig();
  const reply = await requestBrowserDecision(instruction, requestSignal, {
    model: config.ui.planModel ?? 'gpt-5.6-sol',
    reasoningEffort: config.ui.planReasoning || 'high',
    publish: text => onProgress?.({ phase: 'generating', text: planProgressText(text) })
  });
  requestSignal.throwIfAborted();
  let data: unknown;
  try { data = JSON.parse(reply.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')); }
  catch { throw new Error('The planner returned invalid JSON; nothing was queued'); }
  const stages = (data as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(stages) || stages.length < 2 || stages.length > 12 ||
      stages.some(stage => typeof stage !== 'string' || !stage.trim() || stage.length > 16000) || JSON.stringify(stages).length > 12000)
    throw new Error('The planner returned invalid stages; nothing was queued');
  onProgress?.({ phase: 'ready', text: stages.join('\n\n').slice(-8000) });
  return stages.map(stage => (stage as string).trim());
}
