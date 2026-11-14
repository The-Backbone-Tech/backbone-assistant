// Child process for the door's kill-during-dispatch tests: the gateway kills itself at BACKBONE_CRASH_AT
// (effect.claimed or effect.begun) while carrying out one outbox.write.
import { openGateway } from '../src/composition/gateway.ts';

const [home, grant, key] = process.argv.slice(2);
const gateway = await openGateway({ home, grant, dispatchLeaseMs: 500 });
await gateway.call('effects.propose', { operation: 'outbox.write', args: { name: `${key}.txt`, content: key }, description: 'crash test', idempotencyKey: key });
console.error('propose returned without crashing');
