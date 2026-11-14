// Trusted in-process channel credentials. No value is reachable through Host.call or the API line.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeDurable } from '@backbone-next/kernel/files';
import { assertHomeWriteAdmission, withHomeLock } from '../composition/home-lock.ts';
import { Vault, type HomeKeys } from '../keys/vault.ts';
import { CredentialStore } from './store.ts';

export const CHANNEL_TOKEN_KINDS = ['slack-bot','slack-signing','telegram-bot','telegram-webhook','discord-bot','discord-registration','teams-password','teams-registration'] as const;
export type ChannelTokenKind = typeof CHANNEL_TOKEN_KINDS[number];
type Provider = 'slack' | 'telegram' | 'discord' | 'teams';
type Index = Partial<Record<ChannelTokenKind,string>>;
const kinds = (provider: Provider): [ChannelTokenKind,ChannelTokenKind] => provider==='slack'?['slack-bot','slack-signing']:provider==='telegram'?['telegram-bot','telegram-webhook']:provider==='discord'?['discord-bot','discord-registration']:['teams-password','teams-registration'];

export async function channelCredentials(home: string, keys?: HomeKeys) {
  const vault = await Vault.open(home,keys);
  const store = new CredentialStore(home,()=>vault.masterKey());
  const path = join(home,'credentials','channels.json');
  const index = (): Index => {
    if (!existsSync(path)) return {};
    const value: unknown = JSON.parse(readFileSync(path,'utf8'));
    if (!value || typeof value!=='object' || Object.entries(value).some(([k,v])=>!CHANNEL_TOKEN_KINDS.includes(k as ChannelTokenKind)||typeof v!=='string'||!/^cred_[0-9a-f-]{36}$/.test(v))) throw new Error('Channel credential handles need inspection.');
    return value as Index;
  };
  return {
    async connect(provider: Provider, token: string, verification: string): Promise<void> {
      if (!['slack','telegram','discord','teams'].includes(provider) || [token,verification].some(v=>!v||v.length>16384||/[\r\n\0]/.test(v))) throw new Error('Supply a token and verification secret as two nonempty lines.');
      await withHomeLock(join(home,'credentials','channel-settings'),async()=>{
        const prior=index(), next={...prior}, pair=kinds(provider);
        next[pair[0]]=await store.put(token,pair[0]);
        next[pair[1]]=await store.put(verification,pair[1]);
        assertHomeWriteAdmission(home,join(home,'credentials'));
        writeDurable(path,JSON.stringify(next));
        for (const kind of pair) if (prior[kind]) store.revoke(prior[kind]!);
      });
    },
    async resolve(provider: Provider): Promise<{token: string; verification: string}> {
      if (!['slack','telegram','discord','teams'].includes(provider)) throw new Error('Unknown channel provider.');
      const saved=index(), pair=kinds(provider);
      if (!saved[pair[0]]||!saved[pair[1]]) throw new Error('Connect this channel before running it.');
      return {token:await store.resolve(saved[pair[0]]!),verification:await store.resolve(saved[pair[1]]!)};
    }
  };
}
