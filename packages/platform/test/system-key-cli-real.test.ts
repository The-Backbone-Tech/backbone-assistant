import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import { childHangTimer } from '../../../scripts/lib/test-child.ts';
// Explicit opt-in only: three real CLI commands share one newly created, unlocked scratch keychain.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeDataHome } from '../src/composition/host.ts';
import { runTool, securityWord, toolEnvironment } from '../src/system-keys/tools.ts';
import { cleanupTemporaryKeychain } from './system-key-cleanup.ts';

const enabled = process.platform === 'darwin' && process.env.BACKBONE_TEST_SYSTEM_KEYCHAIN === '1';
test('CLI real-store case is macOS-only and explicitly opted in', () => { assert.equal(enabled, process.platform === 'darwin' && process.env.BACKBONE_TEST_SYSTEM_KEYCHAIN === '1'); });
if (enabled) test('real CLI creates, lists and diagnoses a home in an unlocked scratch keychain', { timeout: TEST_HANG_MS * 2 }, async (t) => {
  const denial = process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE;
  delete process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE;
  t.after(() => { if (denial === undefined) delete process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE; else process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE = denial; });
  const root = mkdtempSync(join(tmpdir(), 'backbone-cli-keychain-')), home = join(root, 'home'), keychain = join(root, 'scratch.keychain-db');
  const env = toolEnvironment('darwin', {}), password = randomBytes(32).toString('base64');
  const interactive = async (words: string[]) => runTool({ executable: '/usr/bin/security', args: ['-q', '-i'], input: Buffer.from(words.map(securityWord).join(' ') + '\n'), env });
  let made = false;
  try {
    assert.equal((await interactive(['create-keychain', '-p', password, keychain])).code, 0); made = true;
    assert.equal((await interactive(['unlock-keychain', '-p', password, keychain])).code, 0);
    // No lock command, settings query or default/login scope is ever part of this test.
    const actual = new URL('../src/system-keys/index.ts', import.meta.url).href;
    const tools = new URL('../src/system-keys/tools.ts', import.meta.url).href;
    const guard = new URL('./system-key-cli-guard.ts', import.meta.url).href;
    const preload = `import {installScratchGuard} from ${JSON.stringify(guard)};installScratchGuard(${JSON.stringify(keychain)});`;
    const source = `
      import assert from 'node:assert/strict';
      import {chooseKeys as choose,toolStore} from ${JSON.stringify(actual)};
      import {securityWord} from ${JSON.stringify(tools)};
      import {markScopedHook,runScopedTool} from ${JSON.stringify(guard)};
      markScopedHook();
      export * from ${JSON.stringify(actual)};
      const keychain=${JSON.stringify(keychain)};
      const store=toolStore({platform:'darwin',env:{},keychain,run:r=>{
        assert.equal(r.executable,'/usr/bin/security');
        if(r.args[0]==='-q')assert.ok(r.input?.toString().endsWith(securityWord(keychain)+'\\n'));
        else assert.equal(r.args.at(-1),keychain);
        return runScopedTool(r);
      }});
      export const chooseKeys=(home,env,_store,options)=>choose(home,env,store,options);
    `;
    const boot = `import {registerHooks} from 'node:module';registerHooks({resolve(s,c,n){return s==='@backbone-next/platform/system-keys'?{url:'test:scoped-cli-keys',shortCircuit:true}:n(s,c)},load(u,c,n){return u==='test:scoped-cli-keys'?{format:'module',source:${JSON.stringify(source)},shortCircuit:true}:n(u,c)}});`;
    const main = new URL('../../surfaces/cli/src/main.ts', import.meta.url).pathname;
    async function cli(args: string[]) {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, BACKBONE_HARNESS: 'stub' }; delete childEnv.BACKBONE_KEYS; delete childEnv.BACKBONE_SYSTEM_STORE_UNAVAILABLE;
      const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), '--import', 'data:text/javascript,' + encodeURIComponent(boot), main, ...args, '--home', home], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = ''; child.stdout.on('data', (v) => { out += v; }); child.stderr.on('data', (v) => { err += v; });
      const timer = childHangTimer(child, 'system-key-cli-real.test: child completion/shutdown');
      try { assert.equal(await new Promise((r) => child.once('close', r)), 0, err); assert.match(err, /SCOPED_CLI_HOOK_LOADED/); return out; }
      finally { clearTimeout(timer); }
    }
    await cli(['projects', 'create', 'My project']);
    assert.match(await cli(['projects', 'list']), /My project/);
    const doctor = JSON.parse(await cli(['doctor', '--json']));
    assert.match(doctor.checks.find((c: { name: string }) => c.name === 'keys').detail, /os-keyring-v1/);
    const vault = JSON.parse(readFileSync(join(home, 'keys', 'vault.json'), 'utf8'));
    assert.equal(vault.wrap, 'os-keyring-v1'); assert.equal(vault.holder, 'keychain'); assert.notEqual(Buffer.from(vault.key, 'base64').length, 32);
    assert.equal(existsSync(join(home, 'keys', 'system-protected')), false, 'CLI reads must not publish the optional marker');
  } finally {
    await cleanupTemporaryKeychain(() => removeDataHome(home), async () => {
      if (made || existsSync(keychain)) assert.equal((await runTool({ executable: '/usr/bin/security', args: ['delete-keychain', keychain], env })).code, 0);
    }, () => rmSync(root, { recursive: true, force: true }));
  }
});
