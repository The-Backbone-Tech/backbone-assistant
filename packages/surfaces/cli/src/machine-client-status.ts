import type { ModelSettings } from '@backbone-next/platform';
import type { Api } from './commands.ts';
import { setTimeout } from 'node:timers/promises';

/** Doctor can await the Host's pending probe without launching one or using terminal credentials. */
export async function doctorModelSettings(api: Api): Promise<ModelSettings> {
  const until = Date.now() + 6_000;
  for (;;) {
    const settings = await api.call('settings.model.get', {});
    if (settings.machineClientState?.state !== 'checking' || Date.now() >= until) return settings;
    await setTimeout(25);
  }
}
