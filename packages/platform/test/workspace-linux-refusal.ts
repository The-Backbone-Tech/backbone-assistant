// The parent confines this owned helper in a namespace that forbids further user namespaces.
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/workspace/store.ts';
import { workspaceProcess } from '../src/workspace/runtime.ts';
const root = process.argv[2]!;
const store = new WorkspaceStore('owned-refusal', { root: join(root, 'storage') });
if (process.argv[3] === 'runtime') {
  // The parent already qualified and allocated this record. Make only the actual launch
  // unavailable, as can happen after a cached successful discovery.
  const record = (await store.inspect('thread'))!;
  const pointer = readFileSync(join(record.folder, 'checkpoint.json'), 'utf8');
  const result = await new Promise<{ reason?: string }>((resolve, reject) => {
    const child = execFile('/usr/bin/python3', ['-I', '-S', '-c', readFileSync(workspaceProcess('linux'), 'utf8'), 'run', record.folder, randomUUID(), String(process.pid)], { timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
    child.stdin!.on('error', () => {});
    child.stdin!.write(JSON.stringify({ command: `echo must-not-run > ${JSON.stringify(join(root, 'canary'))}`, inputs: [], expiresAt: record.expiresAt }) + '\n');
  });
  assert.match(result.reason ?? '', /Linux namespace setup refused/);
  assert.equal(existsSync(join(record.folder, '.retiring')), false);
  assert.equal(readFileSync(join(record.folder, 'checkpoint.json'), 'utf8'), pointer);
  process.stdout.write('runtime admission refused; checkpoint retained\n');
} else {
try {
  await store.run('thread', { command: `echo must-not-run > ${JSON.stringify(join(root, 'canary'))}`, inputs: [] });
  throw new Error('A refused namespace unexpectedly admitted a command');
} catch (error) {
  if (process.argv[3] === 'cgroup' && error instanceof Error && /delegated cgroup/i.test(error.message)) {
    process.stdout.write('cgroup refused before allocation\n');
  } else if (!(error instanceof Error) || !/^(Linux namespace setup refused; bubblewrap, unprivileged user namespaces and tmpfs are required|Linux namespace, volume or seccomp preflight refused execution|Linux namespace, bounded-volume or seccomp preflight refused execution; no workspace was created\.)$/.test(error.message)) throw error;
  process.stdout.write('refused before allocation\n');
}
}
