// A fake signed-in Codex client for the journeys: the harness's own strict fake behind a catalog of
// two models, recording what each turn actually asked the client for. No sign-in, no model, no quota.
// It runs the fake in this process, so the client is one process, not a launcher and a child.
//   node codex-client.mjs <log file> <fake client> <client arguments…>
// BACKBONE_FAKE_CODEX_MODE picks the fake's mode (default `phased`), e.g. `spawn` for a turn that
// delegates to one sub-agent, shaped as Codex 0.165 reports it.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [log, client, ...args] = process.argv.slice(2);
const efforts = (...names) => names.map((reasoningEffort) => ({ reasoningEffort }));
const catalog = [
  { id: 'fast-model', displayName: 'Fast model', hidden: false, supportedReasoningEfforts: efforts('low', 'medium') },
  { id: 'deep-model', displayName: 'Deep model', hidden: false, supportedReasoningEfforts: efforts('high', 'xhigh') },
];
const listing = new Set();
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'model/list') listing.add(id);
  if (method === 'turn/start') appendFileSync(log, `${JSON.stringify({ model: params.model, effort: params.effort })}\n`);
});
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  // Only the protocol is JSON: --version and the sandbox commands print plain lines.
  const id = String(chunk).startsWith('{') ? JSON.parse(chunk).id : undefined;
  return write(listing.has(id) ? `${JSON.stringify({ id, result: { data: catalog, nextCursor: null } })}\n` : chunk, ...rest);
};
process.argv = [process.argv[0], client, process.env.BACKBONE_FAKE_CODEX_MODE || 'phased', ...args];
await import(client);
