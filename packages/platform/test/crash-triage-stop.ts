// A real process dies after persisting Stop while the provider's read is still in flight.
import { join } from 'node:path';
import { FakeMailbox, readSeed } from '@backbone-next/connector-mail';
import { createHost } from '../src/composition/host.ts';
const [home] = process.argv.slice(2);
const seed = readSeed();
const mailbox = new FakeMailbox({ stateFile: join(home, 'mailbox', 'sample.json'), seed: { ...seed, messages: seed.messages.slice(0, 2) } });
const host = createHost({ home, mail: { connector: mailbox } });
mailbox.read = async () => {
  host.triage!.stop();
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL did not terminate the process');
};
const connected = await host.call('triage.connect', {});
if (!connected.ok) throw new Error(connected.detail);
const offer = (await host.call('triage.get', {})).offer!;
const signed = await host.signCapability({ hash: offer.hash, presence: 'touch-id' });
if (!signed.ok) throw new Error(signed.detail);
await host.triage!.whenIdle();
throw new Error('The process did not reach the blocked read');
