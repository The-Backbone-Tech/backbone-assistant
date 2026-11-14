// Child process for the outbox tests: grantDoor kills itself at BACKBONE_CRASH_AT=grant.issued, after
// the core committed the mandate under its intent and before its run is queued or its file published.
import { grantDoor } from '../src/composition/gateway.ts';

const [home, name, intent] = process.argv.slice(2);
await grantDoor({ home, name, intent, operations: ['outbox.write'], ceiling: 3, days: 30 });
console.error('grantDoor returned without crashing');
