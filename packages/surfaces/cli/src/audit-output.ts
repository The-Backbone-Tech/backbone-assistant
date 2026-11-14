// A successful export means all bytes reached the writable, including a backpressured pipe.
import {AUDIT_WRITE_TIMEOUT_MS} from '@backbone-next/platform/audit';
import type { Writable } from 'node:stream';

export function writeAuditOutput(stream: Writable, bytes: string, timeoutMs = AUDIT_WRITE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer=setTimeout(()=>reject(new Error('No audit output progress within 30 seconds.')),timeoutMs);
    const failed=(error:Error)=>{clearTimeout(timer);reject(error);};
    stream.once('error', failed);
    stream.write(bytes, error => {
      clearTimeout(timer);
      if (error) { reject(error); return; } // Keep the error listener for the ensuing error event.
      stream.off('error', failed);
      resolve();
    });
  });
}
