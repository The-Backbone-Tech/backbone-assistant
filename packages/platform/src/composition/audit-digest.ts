// Derive an audit-only key from the existing credential master; never persist the derived key.
import {createHmac,hkdfSync} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {AuditInvalid,type AuditDigestKey} from '../audit.ts';
import type {Vault} from '../keys/vault.ts';
export type AuditRedigest = (value:string,purpose?:string)=>Promise<string>;
export interface AuditDigester {redigest:AuditRedigest;keyInfo():Promise<AuditDigestKey>}
export function auditDigester(home:string,homeId:string,vault:Vault):AuditDigester{
  let pending:Promise<{key:Buffer;derivation:AuditDigestKey['derivation']}>|undefined;
  const secret=()=>pending??=(async()=>{
    const master=vault.get('credentials.master');
    if(master)return{key:Buffer.from(hkdfSync('sha256',master,Buffer.from(homeId),Buffer.from('backbone.audit.v1/digest-key'),32)),derivation:'hkdf-master-sha256' as const};
    // masterKey() would create the missing entry. Neither transport may write keys during export.
    const external=join(home,'pg','external.json');
    const password=existsSync(external)?decodeURIComponent(new URL(JSON.parse(readFileSync(external,'utf8')).appUrl).password):(await vault.passwords().read())?.app;
    if(!password)throw new AuditInvalid('This data folder has neither a credential master nor an existing service secret for audit anchors.');
    return{key:Buffer.from(password),derivation:'legacy-service-secret' as const};
  })();
  return{
    redigest:async(value,purpose='receipt')=>createHmac('sha256',(await secret()).key).update(`backbone.audit.v1\0${homeId}\0${purpose}\0${value}`).digest('hex'),
    async keyInfo(){const {key,derivation}=await secret();return{id:createHmac('sha256',key).update(`backbone.audit.v1/key-id\0${homeId}`).digest('hex').slice(0,32),derivation};},
  };
}
