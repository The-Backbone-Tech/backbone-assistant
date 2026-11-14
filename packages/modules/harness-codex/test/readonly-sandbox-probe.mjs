// Independent shell canary. Linux read-only qualifies Host immutability, not syscall refusal.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, readFile, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
const root = await realpath(await mkdtemp(join(tmpdir(), 'backbone-ro-sandbox-'))), stage = join(root, 'workspace');
await mkdir(stage); await writeFile(join(stage, 'source'), 'inside'); await writeFile(join(root, 'outside'), 'outside');
await symlink(join(root, 'outside'), join(stage, 'link'));
let hits = 0;
const server = createServer((_q, response) => { hits++; response.end('sentinel'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const script = 'ir=denied; or=denied; lr=denied; iw=denied; ow=denied; child=denied; net=denied; /bin/cat "$1" >/dev/null 2>&1 && ir=allowed; /bin/cat "$2" >/dev/null 2>&1 && or=allowed; /bin/cat "$3" >/dev/null 2>&1 && lr=allowed; (printf x > "$4") 2>/dev/null && iw=allowed; (printf x > "$5") 2>/dev/null && ow=allowed; /bin/sh -c "/bin/cat \\\"$2\\\" >/dev/null 2>&1" && child=allowed; /usr/bin/curl --max-time 2 -fsS "$6" >/dev/null 2>&1 && net=allowed; printf "inside_read=%s outside_read=%s symlink_read=%s inside_write=%s outside_write=%s child_read=%s network=%s\\n" "$ir" "$or" "$lr" "$iw" "$ow" "$child" "$net"';
const profile = 'permissions.backbone-native-staged.filesystem={ ":root"="deny", ":minimal"="read", ":workspace_roots"="read"' + (process.platform === 'darwin' ? ', "/tmp"="deny", "/var/tmp"="deny", "/private/tmp"="deny", "/private/var/tmp"="deny"' : '') + ' }';
async function run(program, values) {
  const child = spawn('codex', ['sandbox', '-C', stage, '-P', 'backbone-native-staged', '-c', profile, '-c', 'permissions.backbone-native-staged.network.enabled=false', '--', '/bin/sh', '-c', program, 'probe', ...values]);
  let out = '', err = '';
  child.stdout.on('data', value => out += value); child.stderr.on('data', value => err += value);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0); return { out: out.trim(), err };
}
try {
  const result = await run(script, [join(stage, 'source'), join(root, 'outside'), join(stage, 'link'), join(stage, 'out'), join(root, 'out'), 'http://127.0.0.1:' + port + '/']);
  const expected = 'inside_read=allowed outside_read=denied symlink_read=denied inside_write=denied outside_write=denied child_read=denied network=denied';
  if (process.platform === 'linux') {
    assert.ok([expected, expected.replace('outside_write=denied', 'outside_write=allowed')].includes(result.out));
    await assert.rejects(lstat(join(root, 'out')), { code: 'ENOENT' });
    assert.deepEqual((await readdir(root)).sort(), ['outside', 'workspace']);
    assert.deepEqual((await readdir(stage)).sort(), ['link', 'source']);
    assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'outside');
    assert.equal(await readFile(join(stage, 'source'), 'utf8'), 'inside');
    for (let i = 0; i < 2; i++) {
      const later = await run('test ! -e "$1" && /bin/cat "$2"', [join(root, 'out'), join(stage, 'source')]);
      assert.equal(later.out, 'inside');
    }
  } else assert.equal(result.out, expected);
  assert.equal(hits, 0);
  console.log(JSON.stringify({ code: 0, observed: result.out, hostUnchanged: true, laterProcesses: process.platform === 'linux' ? 2 : 0, loopbackRequests: hits, stderr: result.err.slice(0, 300) }));
} finally {
  server.closeAllConnections(); server.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
