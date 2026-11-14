// Child process for the kill-mid-job test: connects the sample mailbox, signs the capability as the
// person, and runs the job, letting the host kill itself at BACKBONE_CRASH_AT (during a draft's write).
import { createHost } from '../src/composition/host.ts';

const [home] = process.argv.slice(2);
const host = createHost({ home });
const connected = await host.call('triage.connect', {});
if (!connected.ok) throw new Error(connected.detail);
const offer = (await host.call('triage.get', {})).offer;
if (!offer) throw new Error('nothing offered');
const signed = await host.signCapability({ hash: offer.hash, presence: 'touch-id' });
if (!signed.ok) throw new Error(signed.detail);
await host.triage!.run('person');
await new Promise((r) => setTimeout(r, 20_000));
console.error('the job finished without crashing');
