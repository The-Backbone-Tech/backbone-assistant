// The connection grant commits, but the process dies before receiving its id.
import { createHost } from '../src/composition/host.ts';
import type { TriageDeps } from '../src/triage/service.ts';
const [home] = process.argv.slice(2);
const host = createHost({ home });
const deps = (host.triage! as unknown as { deps: TriageDeps }).deps;
const link = await deps.link(), call = link.call.bind(link);
link.call = (async (...args: Parameters<typeof link.call>) => {
  const value = await call(...args);
  if (args[1].includes('gov.issue_mandate')) process.kill(process.pid, 'SIGKILL');
  return value;
}) as typeof link.call;
await host.call('triage.connect', {});
throw new Error('The process did not reach connection issuance');
