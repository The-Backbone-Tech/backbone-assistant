import pg from 'pg';
import {afterEach,expect,it,vi} from 'vitest';
import {readOnlyConnectionConfig} from '../src/db/session.ts';
import {PersonalReadRefusal} from '../src/db/personal-readonly.ts';

afterEach(()=>vi.unstubAllEnvs());

for(const options of ['-c statement_timeout=2000','-c default_transaction_read_only=off','--default_transaction_read_only=off','-cdefault_transaction_read_only=off']){
 it(`narrows the effective pg startup configuration after parsing ${options}`,()=>{
  const url=new URL('postgres://synthetic:synthetic@localhost:5432/synthetic');
  url.searchParams.set('options',options);
  const config=readOnlyConnectionConfig(url.toString());
  expect(config.connectionString).toBeUndefined();
  const client=new pg.Client(config);
  const effective=(client as unknown as {connectionParameters:{options:string}}).connectionParameters.options;
  expect(effective).toMatch(/(?:^|\s)(?:-c\s*|--)default_transaction_read_only=on\s*$/);
 });
}

it('retains supported connection identity, TLS, socket and application settings',()=>{
 const url=new URL('postgres://synthetic:synthetic%3Apassword@localhost:5432/synthetic');
 url.searchParams.set('host','/synthetic/socket');url.searchParams.set('sslmode','no-verify');
 url.searchParams.set('application_name','synthetic reader');url.searchParams.set('options','-c statement_timeout=2000');
 const config=readOnlyConnectionConfig(url.toString());
 expect(config).toMatchObject({host:'/synthetic/socket',user:'synthetic',password:'synthetic:password',port:5432,database:'synthetic',application_name:'synthetic reader',ssl:{rejectUnauthorized:false}});
});

it('retains the native client TLS behavior for legacy SSL URL settings',()=>{
 for(const value of ['no-verify','require','']){
  const url=new URL('postgres://synthetic:synthetic@localhost/synthetic');url.searchParams.set('ssl',value);
  const original=new pg.Client({connectionString:url.toString()}),reader=new pg.Client(readOnlyConnectionConfig(url.toString()));
  const tls=(client:pg.Client)=>{
   const ssl=(client as unknown as {ssl:boolean|string|{rejectUnauthorized?:boolean}}).ssl;
   return {enabled:Boolean(ssl),verify:typeof ssl==='object'?ssl.rejectUnauthorized!==false:true};
  };
  expect(tls(reader)).toEqual(tls(original));
 }
});

it('retains PGOPTIONS while giving the final startup switch to the reader',()=>{
 vi.stubEnv('PGOPTIONS','--default_transaction_read_only=off --statement_timeout=2000');
 const options=readOnlyConnectionConfig('postgres://synthetic:synthetic@localhost/synthetic').options!;
 expect(options).toContain('--statement_timeout=2000');expect(options).toMatch(/default_transaction_read_only=on\s*$/);
});

it('does not let an unknown URL parameter request another connection-string parse',()=>{
 const url=new URL('postgres://synthetic:synthetic@localhost/synthetic');
 url.searchParams.set('connectionString','postgres://other:other@elsewhere/other?options=-c%20default_transaction_read_only%3Doff');
 const config=readOnlyConnectionConfig(url.toString()),client=new pg.Client(config);
 expect(config.connectionString).toBeUndefined();expect(client.host).toBe('localhost');expect(client.database).toBe('synthetic');
 expect((client as unknown as {connectionParameters:{options:string}}).connectionParameters.options).toMatch(/default_transaction_read_only=on$/);
});

it('preserves native handling of an unmatched trailing escape before appending a switch',()=>{
 const url=new URL('postgres://synthetic:synthetic@localhost/synthetic');
 url.searchParams.set('options','-c default_transaction_read_only=off\\');
 const client=new pg.Client(readOnlyConnectionConfig(url.toString()));
 expect((client as unknown as {connectionParameters:{options:string}}).connectionParameters.options).toMatch(/default_transaction_read_only=on\s*$/);
});

it('refuses unsupported connection settings with a fixed type and no echoed value',()=>{
 let caught:unknown;
 try{readOnlyConnectionConfig('postgres://synthetic:synthetic@localhost/synthetic?port=SYNTHETIC_PRIVATE_VALUE');}catch(error){caught=error;}
 expect(caught).toBeInstanceOf(PersonalReadRefusal);
 expect((caught as PersonalReadRefusal).code).toBe('connection-options');
 expect((caught as Error).message).not.toContain('SYNTHETIC_PRIVATE_VALUE');
});
