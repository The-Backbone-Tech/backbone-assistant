// A saved role removes capabilities from the existing host; none is created by this wrapper.
import type { ToolHost } from '../ports/harness.ts';

export function restrictRoleTools(host: ToolHost, allowed: readonly string[] | undefined, onWriteRefused?: (detail: string) => void): ToolHost {
  if (allowed === undefined) return host;
  const has = (name: string) => allowed.includes(name);
  const result: ToolHost = {
    stillGranted: host.stillGranted,
    list: has('Glob') ? () => host.list() : async () => { throw new Error('This agent role does not allow listing files.'); },
    read: has('Read') ? (...args) => host.read(...args) : async () => { throw new Error('This agent role does not allow reading files.'); },
    write: has('Write') ? (...args) => host.write(...args) : async () => {
      const detail = 'This agent role does not allow writing documents.';
      onWriteRefused?.(detail);
      return { outcome: 'REFUSED', detail };
    },
  };
  if (has('Write')) {
    if (host.writeIfVersion) result.writeIfVersion = (...args) => host.writeIfVersion!(...args);
    if (host.checkpoint) result.checkpoint = (...args) => host.checkpoint!(...args);
  }
  if (has('Bash') && host.runWorkspace) result.runWorkspace = (...args) => host.runWorkspace!(...args);
  if (has('memory_search') && host.searchMemory) result.searchMemory = (...args) => host.searchMemory!(...args);
  if (has('propose_memory') && host.proposeMemory) result.proposeMemory = (...args) => host.proposeMemory!(...args);
  if (has('connectors')) {
    if (host.connectors) result.connectors = () => host.connectors!();
    if (host.callConnector) result.callConnector = (...args) => host.callConnector!(...args);
    if (host.reserveConnectorBatch) result.reserveConnectorBatch = (...args) => host.reserveConnectorBatch!(...args);
  }
  return result;
}
