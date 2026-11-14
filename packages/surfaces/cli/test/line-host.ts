// A host that serves the api line, as the app does: it holds the home, and a person's answer stands in
// through LINE_ANSWER (yes, no). The CLI beside it runs with no keys named, so it can only attach.
import { createHost, hostClosed } from '@backbone-next/platform/composition';
import { ApiLineProjectBudget, serveApiLine } from '@backbone-next/platform/composition/api-line';
import { plaintextKeys } from '@backbone-next/platform/keys';

const home = process.env.BACKBONE_HOME as string;
const host = createHost({ home, keys: plaintextKeys(), harness: 'harness-stub' });
await host.call('projects.create', { name: 'One', kind: 'folder' });
const line = await serveApiLine({ home, projectCreation: true, projectCreationBudget: new ApiLineProjectBudget(), call: (m, a) => host.call(m, a), confirm: async () => process.env.LINE_ANSWER === 'yes' });
process.stdout.write('serving\n');
setInterval(() => {}, 1_000); // The line does not keep a process alive; the app's own life does.
process.once('SIGTERM', () => {
  void line.close().then(() => {
    host.close();
    return hostClosed(home);
  }).then(() => process.exit(0));
});
