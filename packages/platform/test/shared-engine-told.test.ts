import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { engineBringsOwnTools } from '../src/composition/engine-settings.ts';
import { freshDir } from './helpers.ts';
import { SharedEngineRequired } from '../src/composition/identity-core.ts';

// The owner is told in advance with the same fact the shared service uses to refuse a colleague's message.
test('the saved engine is reported as one that cannot answer colleagues only when it brings its own tools', () => {
  for (const [engine, brings] of [['codex', true], ['pi', false], ['stub', false]] as const) {
    const home = freshDir('shared-engine-told-');
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ harness: `harness-${engine}` }));
    assert.equal(engineBringsOwnTools(home, 'harness-pi', {}), brings, engine);
  }
  assert.equal(engineBringsOwnTools(freshDir('shared-engine-told-'), 'harness-pi', {}), false, 'a fresh data folder uses the shareable default');
});

test('a colleague is told in plain words that their message was not sent and who can fix it', () => {
  const text = new SharedEngineRequired().message;
  assert.match(text, /was not sent/);
  assert.match(text, /workspace owner/);
  assert.match(text, /Settings › AI and models/);
  assert.match(text, /backbone model shared local/);
  assert.match(text, /stop the (?:background|shared) service.*backbone model shared local.*start it again/);
  assert.match(text, /Shared work/);
  assert.doesNotMatch(text, /daemon/i);
});
