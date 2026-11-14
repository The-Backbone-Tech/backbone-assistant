// Disposable legacy installation only. Roles are cluster-global even when each file has its own
// database, so coordinate their frozen baseline's ALTER ROLE with the owned opener's role lock.
import pg from 'pg';

export async function legacyCoreDatabase(url:string,sql:string):Promise<pg.Client>{
 const target=new URL(url);const name=target.pathname.slice(1);
 if(!/^home_[a-f0-9]+$/.test(name))throw new Error('Legacy fixtures replace only disposable home databases.');
 const controlUrl=new URL(url);controlUrl.pathname='/postgres';
 const control=new pg.Client({connectionString:String(controlUrl)});
 const admin=new pg.Client({connectionString:url});let locked=false;
 try{
  await control.connect();
  // The common control database is essential: advisory locks in different home DBs do not meet.
  await control.query('SELECT pg_advisory_lock(1111573323,1)');locked=true;
  await control.query(`DROP DATABASE ${name}`);await control.query(`CREATE DATABASE ${name}`);
  await admin.connect();await admin.query(sql);
  return admin;
 }catch(error){await admin.end().catch(()=>{});throw error;}
 finally{
  if(locked)await control.query('SELECT pg_advisory_unlock(1111573323,1)').catch(()=>{});
  await control.end();
 }
}
