// Exact checker for T3, kept apart from the executor's inputs (fixtures/t3-invoices). It computes the
// expected ledger itself and compares a candidate exactly: the headers, every row in order, no row
// missing, extra or repeated, each vendor's total once in alphabetical order, and TOTAL last.
// Usage: node verify-t3.mjs <dir with ledger.csv and totals.csv>. Prints PASS or FAIL with reasons,
// never the expected values. Exit 0 only on PASS.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
if (!dir) { console.error('usage: node verify-t3.mjs <candidate dir>'); process.exit(2); }
const fixture = new URL('../fixtures/t3-invoices/', import.meta.url).pathname;
const rows = [
  ['Papelería Norte', '2026-10-03', 1250.40, 'EUR'], ['Cloudly Inc', '2026-10-05', 980.00, 'USD'], ['Papelería Norte', '2026-10-17', 312.60, 'EUR'],
  ['Transportes Rio', '2026-10-21', 2400.00, 'EUR'], ['Cloudly Inc', '2026-11-02', 1020.50, 'USD'], ['Limpiezas Sol', '2026-10-28', 89.99, 'EUR'],
  ['Transportes Rio', '2026-11-04', 1800.00, 'EUR'], ['Cloudly Inc', '2026-11-07', 45.10, 'USD'], ['Limpiezas Sol', '2026-10-30', 89.99, 'EUR'],
  ['Papelería Norte', '2026-11-08', -120.00, 'EUR'],
];
const rate = JSON.parse(readFileSync(join(fixture, 'rates.json'), 'utf8')).USD;
const cents = (a, c) => Math.round((c === 'USD' ? a * rate : a) * 100);
const expected = rows.map(([v, d, a, c]) => [d, v, cents(a, c)]).sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
const totals = new Map();
for (const [, v, c] of expected) totals.set(v, (totals.get(v) ?? 0) + c);
const vendors = [...totals.keys()].sort((a, b) => a.localeCompare(b));
const grand = vendors.reduce((s, v) => s + totals.get(v), 0);
const money = /^-?\d+\.\d{2}$/;
const toCents = (s) => (money.test(s) ? Math.round(Number(s) * 100) : NaN);
/** One CSV line, honouring double quotes. */
const cells = (line) => { const out = []; let cur = ''; let q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
const problems = [];
const read = (f) => { const p = join(dir, f); if (!existsSync(p)) { problems.push(`${f} is missing`); return []; } return readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l, i, all) => !(l === '' && i === all.length - 1)).map(cells); };
const ledger = read('ledger.csv');
if (!ledger.length) problems.push('ledger.csv has no header or rows');
if (ledger.length) {
  if (ledger[0].join(',') !== 'date,vendor,amount_eur') problems.push('ledger.csv header is not date,vendor,amount_eur');
  const body = ledger.slice(1);
  if (body.length !== expected.length) problems.push(`ledger.csv has ${body.length} rows, not ${expected.length}`);
  body.forEach((g, i) => { const e = expected[i]; if (!e) return; if (g.length !== 3 || g[0] !== e[0] || g[1] !== e[1] || toCents(g[2]) !== e[2]) problems.push(`ledger.csv row ${i + 1} is wrong or out of order`); });
}
const tot = read('totals.csv');
if (!tot.length) problems.push('totals.csv has no header or rows');
if (tot.length) {
  if (tot[0].join(',') !== 'vendor,total_eur') problems.push('totals.csv header is not vendor,total_eur');
  const body = tot.slice(1);
  const want = [...vendors.map((v) => [v, totals.get(v)]), ['TOTAL', grand]];
  if (body.length !== want.length) problems.push(`totals.csv has ${body.length} rows, not ${want.length} (each vendor once, then TOTAL)`);
  body.forEach((g, i) => { const w = want[i]; if (!w) return; if (g.length !== 2 || g[0] !== w[0] || toCents(g[1]) !== w[1]) problems.push(`totals.csv row ${i + 1} is wrong, repeated or out of order`); });
}
console.log(problems.length ? `FAIL\n${problems.join('\n')}` : 'PASS');
process.exit(problems.length ? 1 : 0);
