import { describe, expect, it } from 'vitest';
import { refused, useTarget } from '../harness.ts';

// Its own installation, which holds no workspace yet: the first one is the service's to create.
const target = useTarget('isolation.first-workspace');

describe('crossings that choose a workspace start from an empty session and leave none behind', () => {
  it('[S1] a workspace is created from an empty session, which then acts only in the new workspace', async () => {
    const nobody = target().setWorkspace(null);
    const seen = await nobody.call<{ created: string; visible: string[] }>('iso.workspace.create_first_and_look', { name: 'Mine' });
    expect(seen.visible).toEqual([seen.created]);
    // Once it holds one, every further workspace is the operator's.
    await refused(nobody.call('iso.workspace.create_first_and_look', { name: 'Another' }), 'role');
    const [owner] = (await target().setWorkspace(seen.created).observe<{ id: string; kind: string }>('principal')).filter(
      (p) => p.kind === 'person',
    );
    if (!owner) throw new Error('the first workspace has no owner visible to its own session');
    const elsewhere = await target().operator.createWorkspace({ name: 'Elsewhere', kind: 'team', ownerName: 'E', ownerEmail: 'e@example.com' });
    const sessions = [
      target().setWorkspace(seen.created).asPrincipal(owner.id),
      target().setWorkspace(elsewhere.workspace),
      target().setWorkspace(null).asPrincipal(owner.id),
    ];
    for (const session of sessions) await refused(session.call('workspace.create_first', { name: 'Mine' }), 'empty_session_only');
  });
});
