// Test-process-only failure at the Core crossing. Host/service produce the diagnostic.
// Loaded by the journey's child process; no receipt or authority file is fabricated.
import { CoreLink } from '../../../../platform/src/composition/core.ts';
const call = CoreLink.prototype.call;
let failNextEnd = true;
CoreLink.prototype.call = async function<T>(...args: Parameters<typeof call>): Promise<T> {
  if (failNextEnd && String(args[1]).includes('gov.end_connector_signature')) {
    failNextEnd = false;
    throw new Error('PRIVATE_TEST_BACKEND_CONTEXT');
  }
  return call.apply(this, args) as Promise<T>;
};
