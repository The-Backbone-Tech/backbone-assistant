// Physical subtransaction status is not permission to change neighboring data.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {freshDir} from './helpers.ts';
import {assertHomeState,homeState} from './readonly-home-state.ts';
for(const relative of ['pg/data/pg_subtrans/0000','pg/data/pg_subtrans-neighbor/0000','pg/data/postgresql.auto.conf'])test(`subtransaction recovery keeps the physical boundary at ${relative}`,()=>{
 const home=freshDir('backbone-identity-physical-'),file=join(home,relative);
 mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'before');const before=homeState(home);writeFileSync(file,'after');
 assert.throws(()=>assertHomeState(before,homeState(home)),'ordinary inspection has no physical exception');
 if(relative==='pg/data/pg_subtrans/0000')assertHomeState(before,homeState(home),true);
 else assert.throws(()=>assertHomeState(before,homeState(home),true),'neighbors and configuration retain their exact pin');
});
