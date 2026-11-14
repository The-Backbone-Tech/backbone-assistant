import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, jobProblems } from './acceptance.mjs';
import { repositoryChecks } from './check.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('acceptance jobs extend local conformance and own existing local paths without a sibling', () => {
  const root = mkdtempSync(join(tmpdir(), 'acceptance-local-'));
  try {
    mkdirSync(join(root, 'conformance/C-01'), { recursive: true });
    writeFileSync(join(root, 'conformance/C-01/job.json'), '{}');
    mkdirSync(join(root, 'packages/core'), { recursive: true });
    const job = { title: 't', owns: ['packages/core'], conformance: 'conformance/C-01' };
    assert.deepEqual(jobProblems(root, 'J-x', job), []);
    for (const bad of [
      { ...job, conformance: undefined },
      { ...job, conformance: 'conformance/C-missing' },
      { ...job, owns: ['packages/missing'] },
      { ...job, owns: ['../outside'] },
      { ...job, owns: [] },
      { ...job, owns: 'packages/core' },
    ]) assert.ok(jobProblems(root, 'J-x', bad).length > 0);
    mkdirSync(join(root, 'acceptance/J-x'), { recursive: true });
    writeFileSync(join(root, 'acceptance/README.md'), '# Index');
    writeFileSync(join(root, 'acceptance/J-x/job.json'), JSON.stringify(job));
    assert.deepEqual(check(root), []);
    assert.deepEqual(repositoryChecks(root, {}).acceptance(), []);
    writeFileSync(join(root, 'acceptance/J-x/job.json'), '{broken');
    assert.ok(check(root).length > 0);
    assert.ok(repositoryChecks(root, {}).acceptance().length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('the relocated T3 scorer accepts the canonical ledger and refuses a one-cent error', () => {
  const root = mkdtempSync(join(tmpdir(), 'acceptance-t3-'));
  const scorer = fileURLToPath(new URL('../acceptance/J-solution/method-v1/scoring/verify-t3.mjs', import.meta.url));
  try {
    // Independently calculated from the frozen task: date order, fixed USD rate 0.92, cents per row.
    writeFileSync(join(root, 'ledger.csv'), `date,vendor,amount_eur
2026-10-03,Papelería Norte,1250.40
2026-10-05,Cloudly Inc,901.60
2026-10-17,Papelería Norte,312.60
2026-10-21,Transportes Rio,2400.00
2026-10-28,Limpiezas Sol,89.99
2026-10-30,Limpiezas Sol,89.99
2026-11-02,Cloudly Inc,938.86
2026-11-04,Transportes Rio,1800.00
2026-11-07,Cloudly Inc,41.49
2026-11-08,Papelería Norte,-120.00
`);
    const totals = `vendor,total_eur
Cloudly Inc,1881.95
Limpiezas Sol,179.98
Papelería Norte,1443.00
Transportes Rio,4200.00
TOTAL,7704.93
`;
    writeFileSync(join(root, 'totals.csv'), totals);
    const good = spawnSync(process.execPath, [scorer, root], { cwd: root, encoding: 'utf8' });
    assert.equal(good.status, 0, good.stdout + good.stderr);
    writeFileSync(join(root, 'totals.csv'), totals.replace('7704.93', '7704.94'));
    const bad = spawnSync(process.execPath, [scorer, root], { cwd: root, encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
