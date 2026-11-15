import { convertOffice } from './office-converter';
import { previewErrorMessage } from './preview-boundary';
// Converters receive bytes only. Disable network primitives as defence in depth.
const refuse = () => { throw new Error('Document previews cannot access the network.'); };
Object.defineProperty(globalThis, 'fetch', { value: refuse, writable: false });
Object.defineProperty(globalThis, 'XMLHttpRequest', { value: refuse, writable: false });
Object.defineProperty(globalThis, 'WebSocket', { value: refuse, writable: false });
self.onmessage = async (event: MessageEvent<{ name: string; bytes: Uint8Array }>) => {
  try { self.postMessage({ value: await convertOffice(event.data.name, event.data.bytes) }); }
  catch (error) { self.postMessage({ error: previewErrorMessage(error) }); }
};
