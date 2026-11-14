import type { CoreLink } from '../composition/core.ts';
import type { ClassifiedOperation } from '../ports/mail.ts';
import type { Connection, EffectRow, Stored } from './service.ts';

type Receipt = EffectRow & { decision_status: string | null; created_at: Date };
export async function readEffects(link: CoreLink, state: Stored): Promise<Map<string, Receipt>> {
  const tasks = [...new Set([...(state.tasks ?? []), ...(state.connection ? [state.connection.task] : [])])];
  if (!tasks.length) return new Map();
  const { rows } = await link.read<Receipt>(link.system(), `SELECT e.id, e.status, e.route_reason, e.args, e.args_hash, e.decision_id, e.operation, e.mandate_id, e.expected_version, e.note, e.created_at, e.resolver_id, e.resolve_by, d.status AS decision_status
    FROM app.effects e LEFT JOIN app.decisions d ON d.workspace_id = e.workspace_id AND d.id = e.decision_id WHERE e.task_id = ANY($1::uuid[])`, [tasks]);
  return new Map(rows.map((row) => [row.id, row]));
}

/** Registration can change while an old physical change is unresolved; it still cannot be resent. */
export function uncertainMail(effects: Map<string, EffectRow>, bindings: Stored['bindings'], op: ClassifiedOperation, owner: Pick<Connection, 'provider' | 'account'>): boolean {
  const list = (value: unknown) => JSON.stringify(Array.isArray(value) ? [...value].sort() : null);
  return [...effects.values()].some((e) => {
    if (!['unknown', 'dispatching'].includes(e.status) || e.operation !== op.operation) return false;
    let binding = bindings?.[e.id];
    if (!binding) { try { const note = JSON.parse(e.note ?? '{}'); binding = note.binding ?? note.recovery; } catch { /* Missing ownership stays ambiguous. */ } }
    if (binding && (binding.provider !== owner.provider || binding.account !== owner.account)) return false;
    return ['op', 'id', 'version'].every((k) => e.args[k] === op.args[k]) && list(e.args.add) === list(op.args.add) && list(e.args.remove) === list(op.args.remove);
  });
}
