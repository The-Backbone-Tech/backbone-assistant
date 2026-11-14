// Trusted test setup uses the same real question snapshot as desktop main. Never manufacture a
// stamp or connector record; production callers must retain the snapshot across the native dialog.
import type { Host } from '../composition/host-types.ts';
export async function enableConnector(host: Pick<Host, 'connectorEnableView' | 'enableConnector'>, serverId: string, tool?: string) {
  const shown = await host.connectorEnableView(serverId, tool);
  if (!shown) throw new Error('The connector is not available for the test person.');
  return host.enableConnector(serverId, tool, shown.stamp);
}
