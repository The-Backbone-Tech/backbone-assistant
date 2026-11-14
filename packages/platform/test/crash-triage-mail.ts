// A real process dies at the synthetic provider boundary; the next host uses its normal sweeper.
import { join } from 'node:path';
import { FakeMailbox, readSeed } from '@backbone-next/connector-mail';
import { createHost } from '../src/composition/host.ts';
const [home, cut] = process.argv.slice(2);
const seed = readSeed();
const mailbox = new FakeMailbox({ stateFile: join(home, 'mailbox', 'sample.json'), writes: 'open', seed: { ...seed, messages: seed.messages.slice(0, 1) } });
const host = createHost({ home, mail: { connector: mailbox } });
const connected = await host.call('triage.connect', {});
if (!connected.ok) throw new Error(connected.detail);
const offer = (await host.call('triage.get', {})).offer!;
const signed = await host.signCapability({ hash: offer.hash, presence: 'touch-id' });
if (!signed.ok) throw new Error(signed.detail);
await host.triage.whenIdle();
const proposal = (await host.call('triage.get', {})).brief.proposed[0];
if (!proposal) throw new Error('No mailbox proposal was formed');
const apply = mailbox.apply.bind(mailbox);
mailbox.apply = async (operation) => {
  if (cut === 'before') process.kill(process.pid, 'SIGKILL');
  const result = await apply(operation);
  process.kill(process.pid, 'SIGKILL');
  return result;
};
await host.call('triage.decide', { effect: proposal.effect, verdict: 'accept' });
throw new Error('The provider cut was not reached');
