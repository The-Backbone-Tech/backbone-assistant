import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {freshHome} from './helpers.ts';
import {backupBeforeIdentityUpgrade,identityUpgradeNotice} from '../src/composition/identity-upgrade-backup.ts';
import {inspectExport} from '../src/composition/backup.ts';

test('startup reuses the inspected export and records its location before installation',async()=>{
 const home=freshHome();
 const copy=await backupBeforeIdentityUpgrade({home,projects:[],documents:()=>[],versionPath:()=>assert.fail(),threads:[],receipts:async()=>[],secrets:async()=>[]});
 assert.equal(inspectExport(copy).summary.folder,copy);
 assert.ok(copy.startsWith(join(home,'backups')+'/'));
 assert.ok(readFileSync(join(home,'logs','identity-upgrade.jsonl'),'utf8').includes(copy));
});
test('an export refusal leaves no completed backup or installation permission',async()=>{
 const home=freshHome();
 await assert.rejects(backupBeforeIdentityUpgrade({home,projects:[],documents:()=>[],versionPath:()=>assert.fail(),threads:[],receipts:async()=>[],secrets:async()=>['abc']}),/shorter/);
 assert.equal(existsSync(join(home,'logs','identity-upgrade.jsonl')),false);
});


test('confirmed rollback names the copy and explains the existing restore mechanism without promising a downgrade',()=>{
 const notice=identityUpgradeNotice({state:'unchanged',backup:'/scratch/copy',reason:'Nothing was changed. A copy of your data from before the update is at /scratch/copy.'});
 assert.match(notice!,/^Nothing was changed\. A copy of your data from before the update is at \/scratch\/copy/);
 assert.match(notice!,/backbone restore/);assert.match(notice!,/new, empty data folder/);assert.match(notice!,/--dry-run/);
 assert.match(notice!,/Schedules and permissions are excluded/);assert.doesNotMatch(notice!,/reinstall/);
 const unknown=identityUpgradeNotice({state:'unconfirmed',backup:'/scratch/copy',reason:'The update outcome could not be confirmed.'});
 assert.match(unknown!,/at \/scratch\/copy/);assert.doesNotMatch(unknown!,/Nothing was changed/);
 assert.equal(identityUpgradeNotice(undefined),undefined);
});
