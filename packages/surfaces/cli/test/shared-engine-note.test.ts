import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { runDaemon } from '../src/daemon.ts';
import { teamCommand } from '../src/remote.ts';
import { parse, EXIT } from '../src/commands.ts';
import { SHARED_ENGINE_NOTE, sharedEngineNote } from '../src/shared-engine-note.ts';

test('the note names the terminal steps and appears only when the engine cannot answer colleagues', () => {
  assert.match(SHARED_ENGINE_NOTE, /stop the background service.*backbone model shared local.*start it again/);
  assert.match(SHARED_ENGINE_NOTE, /Settings.*AI and models.*Shared work/);
  assert.equal(sharedEngineNote('unused', () => true), SHARED_ENGINE_NOTE);
  assert.equal(sharedEngineNote('unused', () => false), undefined);
  assert.match(sharedEngineNote('unused',()=>false,'Shared engine could not load: fixture failure')!,/fixture failure.*stop the background service/);
  assert.equal(sharedEngineNote('unused', () => { throw new Error('unreadable'); }), undefined);
});

// One shared service per engine, in this process on a throwaway data folder; the lines it prints and the invitation text are read as the owner sees them.
for (const [engine, told] of [['codex', true], ['pi', false]] as const) {
  test(`with ${engine} saved, the shared service and the invitation ${told ? 'tell' : 'do not tell'} the owner colleagues cannot be answered`, { timeout: 120_000 }, async t => {
    const home = freshDataHome(`shared-engine-note-${engine}`); t.after(() => removeDataHome(home));
    const before = { keys: process.env.BACKBONE_KEYS, harness: process.env.BACKBONE_HARNESS, home: process.env.BACKBONE_HOME };
    process.env.BACKBONE_KEYS = 'plaintext'; process.env.BACKBONE_HARNESS = engine; process.env.BACKBONE_HOME = home;
    t.after(() => { for (const [name, value] of [['BACKBONE_KEYS', before.keys], ['BACKBONE_HARNESS', before.harness], ['BACKBONE_HOME', before.home]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
    const priorTerm = new Set(process.listeners('SIGTERM')), priorInt = new Set(process.listeners('SIGINT'));
    t.after(() => { for (const fn of process.listeners('SIGTERM')) if (!priorTerm.has(fn)) process.off('SIGTERM', fn); for (const fn of process.listeners('SIGINT')) if (!priorInt.has(fn)) process.off('SIGINT', fn); });
    const said: string[] = [], invitation: string[] = [];
    await runDaemon(home, async line => {
      said.push(line);
      if (!line.includes('Shared workspace:')) return;
      try {
        const io = { out: (text: string) => invitation.push(text), err: (text: string) => invitation.push(text), onInterrupt() {}, holding() {}, pollMs: 10, stopWaitMs: 100 };
        assert.equal(await teamCommand(parse(['team', 'invite'], { BACKBONE_HOME: home, BACKBONE_HARNESS: engine }), io as never), EXIT.OK);
      } finally { process.emit('SIGTERM'); }
    }, '127.0.0.1:0');
    const shared = said.find(line => line.includes('Shared workspace:'))!;
    assert.ok(shared, said.join('\n'));
    assert.equal(shared.includes(SHARED_ENGINE_NOTE), told);
    assert.equal(shared.split('\n').at(-1), told ? SHARED_ENGINE_NOTE : 'Create a join link with backbone team invite.');
    assert.equal(invitation.join('\n').includes(SHARED_ENGINE_NOTE), told, invitation.join('\n'));
    assert.match(invitation.join('\n'), /Join link \(one use/);
  });
}
