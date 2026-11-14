import type { Capability, Spend, TaskNeeds, TurnSettings } from '@backbone-next/platform';

export const CAPABILITIES: { id: Capability; label: string }[] = [
  { id: 'model', label: 'Reason over text' }, { id: 'files', label: 'Read and write workspace files' },
  { id: 'code', label: 'Run code' }, { id: 'mail', label: 'Reach a mailbox' },
];
export const SPENDING: { id: Spend; label: string }[] = [
  { id: 'none', label: 'No route charge' }, { id: 'plan', label: 'Existing plan allowed' }, { id: 'metered', label: 'Metered route allowed' },
];
export const DEFAULT_TASK: TaskNeeds = { needs: ['model', 'files'], network: true, spend: 'plan' };

/** Retry metadata restores exactly the submitted constraints; malformed metadata never widens them. */
export function savedTask(raw: unknown): TaskNeeds | undefined {
  if (typeof raw !== 'string') return;
  try {
    const t = JSON.parse(raw);
    if (!t || !Array.isArray(t.needs) || !t.needs.length || t.needs.some((n: unknown) => !CAPABILITIES.some((c) => c.id === n))
      || typeof t.network !== 'boolean' || !SPENDING.some((s) => s.id === t.spend) || (t.structured !== undefined && typeof t.structured !== 'boolean')) return;
    return { needs: [...t.needs], network: t.network, spend: t.spend, ...(t.structured === undefined ? {} : { structured: t.structured }) };
  } catch { return; }
}

export interface SelectedSubmission {
  projectId: string; threadId?: string; text: string; attachments: string[]; task: TaskNeeds;
  settings: TurnSettings;
}
export function savedSelection(raw: unknown): SelectedSubmission | undefined {
  if (typeof raw !== 'string') return;
  try {
    const p = JSON.parse(raw), task = savedTask(JSON.stringify(p?.task)), s = p?.settings;
    if (!task || typeof p.projectId !== 'string' || !p.projectId || (p.threadId !== undefined && typeof p.threadId !== 'string')
      || typeof p.text !== 'string' || !p.text.trim() || !Array.isArray(p.attachments) || p.attachments.some((id: unknown) => typeof id !== 'string' || !id) || !s || !['full', 'ask', 'auto-review'].includes(s.permission)
      || typeof s.model !== 'string' || !Number.isInteger(s.effort) || s.effort < 1 || s.effort > 5
      || !['this-computer', 'cloud'].includes(s.runsOn) || !['chat', 'plan'].includes(s.mode)) return;
    return { projectId: p.projectId, ...(p.threadId === undefined ? {} : { threadId: p.threadId }), text: p.text, attachments: [...p.attachments], task,
      settings: { permission: s.permission, model: s.model, effort: s.effort, runsOn: s.runsOn, mode: s.mode } };
  } catch { return; }
}
