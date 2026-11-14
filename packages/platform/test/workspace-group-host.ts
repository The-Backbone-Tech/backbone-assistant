// A real disposable Host and local scripted Pi route. The parent kills this whole group.
import { createHost } from '../src/composition/host.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
const model = await startScriptedModel('group-kill-workspace', () => ({ calls: [{ name: 'workspace_run', args: { command: 'echo durable > result; sleep 100' } }] }));
process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
const host = createHost({ home: process.argv[2]!, harness: 'harness-pi' });
const project = await host.call('projects.create', { name: 'Disposable group kill', kind: 'folder' });
if (!project.ok) throw new Error(project.detail);
const turn = await host.call('turns.send', { projectId: project.value.id, text: 'Run local workspace work', attachments: [], clientKey: 'group-kill', settings: { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' } });
if (!turn.ok) throw new Error(turn.detail);
process.send!({ threadId: turn.value.threadId });
