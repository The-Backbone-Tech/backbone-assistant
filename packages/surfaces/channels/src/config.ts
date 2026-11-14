import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TurnSettings } from '@backbone-next/platform';
import { Ledger, type Provider } from './ledger.ts';
export interface ChannelConfig { version: 1; projectId: string; settings: TurnSettings; port: number; providers: Provider[]; baseUrls?: Partial<Record<Provider,string>> }
export function readChannelConfig(home: string): ChannelConfig | undefined {
  if (!existsSync(join(home,'channels','journal.sqlite'))) return undefined;
  const ledger=new Ledger(home);
  try {
    const c=ledger.get<ChannelConfig>('config');
    if (c && (c.version!==1 || !c.projectId || !Array.isArray(c.providers) || c.providers.some(p=>!['slack','telegram','discord','teams'].includes(p)) || !Number.isInteger(c.port)||c.port<0||c.port>65535 || !c.settings || !['ask','auto-review','full'].includes(c.settings.permission) || !c.settings.model || ![1,2,3,4,5].includes(c.settings.effort) || c.settings.runsOn!=='this-computer' || !['chat','plan'].includes(c.settings.mode))) throw new Error('Channel configuration needs inspection.');
    return c;
  } finally {ledger.close();}
}
