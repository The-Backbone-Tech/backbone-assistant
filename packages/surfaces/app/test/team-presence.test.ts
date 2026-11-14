import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('opening a sign-in window preserves the device main window used by the menu bar',()=>{
 const main=readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8');
 assert.ok(main.includes('open(false, false)'));
 assert.match(main,/if \(primary\) mainWindow = win;/);
});
test('identity installers identify their own step in success and failure diagnostics',()=>{
 for(const [file,label] of [['identity-guarantees','Identity guarantees'],['identity-platform','Identity platform']]){
  const source=readFileSync(new URL(`../../../core/src/db/${file}.ts`,import.meta.url),'utf8');
  assert.equal(source.includes('Identity admission closure installation'),false);
  assert.ok(source.includes(`${label} installation and receipt are verified.`));
  assert.ok(source.includes(`${label} installation could not be confirmed`));
 }
});
