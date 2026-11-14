import type { BreadthAdapterOptions } from './breadth-adapters.ts';
import type { Provider } from './ledger.ts';

/** The second stdin line carries public registration metadata for these providers. */
export function providerSettings(provider:Provider,token:string,verification:string,apiUrl?:string):BreadthAdapterOptions {
  try {
    const metadata=JSON.parse(verification) as Record<string,unknown>;
    if(provider==='discord' && typeof metadata.applicationId==='string' && metadata.applicationId.trim() && typeof metadata.publicKey==='string' && /^[a-f0-9]{64}$/i.test(metadata.publicKey))return {discord:{token,applicationId:metadata.applicationId,publicKey:metadata.publicKey,apiUrl}};
    if(provider==='teams' && typeof metadata.appId==='string' && metadata.appId.trim() && typeof metadata.tenantId==='string' && metadata.tenantId.trim())return {teams:{password:token,appId:metadata.appId,tenantId:metadata.tenantId,apiUrl}};
  }catch { /* Never echo credential input in a validation failure. */ }
  throw new Error(provider==='discord'?'Discord needs JSON with applicationId and its 64-digit hexadecimal publicKey on the second input line.':'Teams needs JSON with appId and tenantId on the second input line.');
}
