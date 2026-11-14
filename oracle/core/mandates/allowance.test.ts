import { describe, expect, it } from 'vitest';
import { addPerson, newWorld, refused, useTarget } from '../harness.ts';

const target = useTarget('mandates.allowance');

describe('the verification queue', () => {
  it('[S13] what verifiers spend is counted per workspace and day, against an allowance owners and admins set', async () => {
    const w = await newWorld(target(), 'Allowance');
    await w.owner$.call('man.set_verifier_allowance', { tokens: 1000 });
    expect(Number(await w.verifier$.call('man.verifier_allowance'))).toBe(1000);
    expect(Number(await w.verifier$.call('man.record_verifier_usage', { tokens: 600 }))).toBe(400);
    expect(Number(await w.verifier$.call('man.record_verifier_usage', { tokens: 600 }))).toBe(0);
    for (const session of [w.owner$, w.agent$, w.system$]) await refused(session.call('man.record_verifier_usage', { tokens: 1 }), 'role');
    const member = await addPerson(w, 'Member');
    await refused(member.$.call('man.set_verifier_allowance', { tokens: 5000 }), 'role');
    expect(Number(await w.verifier$.call('man.verifier_allowance'))).toBe(0);
    const other = await newWorld(target(), 'OtherAllowance');
    expect(Number(await other.verifier$.call('man.verifier_allowance'))).toBe(2_000_000);
  });
});
