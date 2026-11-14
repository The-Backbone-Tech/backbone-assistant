import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {startTestPostgres} from '../src/db/testing.ts';
import {closureFixture,waitForNativeBlockPids} from './material-closure-fixture.ts';
import {enter} from '../src/db/session.ts';

for(const crossing of ['unregister_piece','propose_undo'])it(`${crossing} re-reads a waiting administrator after demotion or removal`,async()=>{
 const postgres=await startTestPostgres(),f=await closureFixture(postgres);
 const holder=await f.connect(),waiter=await f.connect();
 try{
  const admin=await f.one<string>(f.actor(f.owner),"gov.identity_add_person('Admin',NULL,'admin')");
  const holderPid=(await holder.query('SELECT pg_backend_pid() AS id')).rows[0].id,waiterPid=(await waiter.query('SELECT pg_backend_pid() AS id')).rows[0].id;
  await enter(holder,f.actor(f.owner));
  await holder.query(crossing==='unregister_piece'?'SELECT gov.identity_change_role($1,\'member\')':'SELECT gov.identity_remove($1)',[admin]);
  await enter(waiter,f.actor(admin));
  const result=waiter.query(crossing==='unregister_piece'?'SELECT gov.unregister_piece($1)':"SELECT gov.propose_undo($1,'{}','undo-test','undo',NULL)",[randomUUID()]).then(()=>null,error=>error as Error);
  await waitForNativeBlockPids(f.admin,waiterPid,holderPid);
  await holder.query('COMMIT');
  const error=await result;expect(error).toBeInstanceOf(Error);expect(error!.message).toMatch(crossing==='unregister_piece'?/role:/:/no_identity:/);
  await waiter.query('ROLLBACK');
 }finally{await holder.query('ROLLBACK');await waiter.query('ROLLBACK');await f.close();await postgres.stop();}
});
