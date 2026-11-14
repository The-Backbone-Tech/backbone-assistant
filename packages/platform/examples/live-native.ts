// One real turn through the installed Codex client: attach a synthetic note, ask for a brief, edit
// it as a person, ask for a follow-up, and print what came back. Spends the signed-in client's quota.
//
//   node packages/platform/examples/live-native.ts [model]
import { createHost, removeDataHome } from '../src/composition/host.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import { freshDataHome } from '../src/testing/data-home.ts';

const home = freshDataHome('live-native');
const host = createHost({ home, keys: plaintextKeys(home), harness: 'harness-codex' });
const value = <T,>(r: { ok: boolean; value?: T; reason?: string } | T): T => {
  const receipt = r as { ok?: boolean; value?: T };
  if (receipt.ok === false) throw new Error(JSON.stringify(r));
  return (receipt.ok === true ? receipt.value : r) as T;
};
const idle = async (threadId: string) => {
  for (;;) {
    const thread = await host.call('threads.get', { id: threadId });
    const turn = value(thread as never as { turns: { status: string }[] });
    if (turn.turns.every((t) => t.status !== 'running' && t.status !== 'streaming' && t.status !== 'pending')) return turn;
    await new Promise((r) => setTimeout(r, 500));
  }
};
try {
  const models = await host.call('models.list', {});
  console.log('models', JSON.stringify(models).slice(0, 300), JSON.stringify(await host.call('settings.model.get', {})).slice(0, 300));
  const model = process.argv[2] ?? (models as { id: string }[])[0]?.id;
  console.log(JSON.stringify(await host.call('settings.model.put', { change: { route: 'native', provider: 'codex', model } } as never)).slice(0, 200));
  const p = value(await host.call('projects.create', { name: 'Live', kind: 'folder' })) as { id: string };
  const base64 = Buffer.from('# Revenue\nUp 4% in Q3. Churn fell to 2.1%.\n').toString('base64');
  const note = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64, mediaType: 'text/markdown' })) as { id: string };
  const settings = { permission: 'full', model, effort: 2, runsOn: 'this-computer', mode: 'chat' } as const;
  const started = Date.now();
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Write brief.md: a two-line summary of the note.', attachments: [note.id], settings, clientKey: 'one' })) as { threadId: string };
  const thread = await idle(sent.threadId) as never as { turns: { status: string; answer?: { text: string }; work?: { harness: string; steps: { label: string }[] }; effects: { outcome: string }[] }[] };
  const t = thread.turns[0];
  console.log(Date.now() - started, 'ms', t.status, t.work?.harness, t.work?.steps.map((s) => s.label), t.effects.map((e) => e.outcome), t.answer?.text);
  for (const m of await host.call('material.list', { projectId: p.id }) as { id: string; name: string; versions: unknown[] }[]) console.log(m.name, m.versions.length, value(await host.call('material.read', { id: m.id }) as never as { text?: string }).text);
} finally {
  await host.close?.();
  removeDataHome(home);
}
