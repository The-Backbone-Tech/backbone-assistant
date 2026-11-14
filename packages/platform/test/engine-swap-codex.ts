// Use the shipped Codex adapter, injecting only the offline native executable through its factory seam.
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PIECE_DIRS } from '../src/composition/pieces.ts';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';
import { freshDir } from './helpers.ts';

export function codexFixture(record: string) {
  const dir = freshDir('swap-codex-piece-');
  for (const rel of pieceFiles(PIECE_DIRS['harness-codex'])) {
    const dest = join(dir, rel); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(PIECE_DIRS['harness-codex'], rel), dest);
  }
  symlinkSync(join(PIECE_DIRS['harness-codex'], 'node_modules'), join(dir, 'node_modules'), 'dir');
  const index = join(dir, 'src/index.ts');
  copyFileSync(index, join(dir, 'src/real.ts'));
  const native = join(dir, 'test/fixtures/native.mjs');
  let fake = readFileSync(native, 'utf8');
  // Reuse the native fixture's host-tools dispatcher and acknowledged result handling.
  const completion = "    notify('item/completed', { turnId: 'native-turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: JSON.stringify({ catalog: dynamicTools, results: hostResults, continued: true }) } });";
  const turn = "      hostCalls = JSON.parse(params.input[0].text.split('HOST_TOOL_CALLS:').at(-1));";
  if (!fake.includes(completion) || !fake.includes(turn)) throw new Error('Native host-tools fixture seam changed');
  fake = fake.replace('const answerTool = (result) => {', 'const answerTool = async (result) => {');
  fake = fake.replace(completion, `    await appendFile(${JSON.stringify(record)}, JSON.stringify({ results: hostResults }) + '\\n');
    notify('item/completed', { turnId: 'native-turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: swapFirst ? 'First answer marker.' : 'Second answer marker.' } });`);
  fake = fake.replace('let hostCalls = [], hostResults = [];', 'let hostCalls = [], hostResults = [], swapFirst = false;');
  fake = fake.replace(turn, `      const prompt = params.input?.[0]?.text ?? '';
      swapFirst = prompt.endsWith('First turn marker.');
      const file = swapFirst ? null : await readFile(join(stage, 'swap.md'), 'utf8').catch(() => null);
      await appendFile(${JSON.stringify(record)}, JSON.stringify({ prompt, file, tools: dynamicTools.map(t => t.name) }) + '\\n');
      if (swapFirst) await writeFile(join(stage, 'swap.md'), 'Document from first engine.');
      const connector = suffix => dynamicTools.find(t => t.name.endsWith('__' + suffix))?.name;
      hostCalls = [{ name: 'memory_search', args: { query: 'orchard' } }, ...(swapFirst
        ? [{ name: connector('plain'), args: { x: 'first' } }]
        : [{ name: connector('draft_note'), args: { text: 'signed second' } }, { name: connector('plain'), args: { x: 'second' } }])];`);
  writeFileSync(native, fake);
  writeFileSync(index, `import { createCodexHarness as real } from './real.ts';\nexport function createCodexHarness(options = {}) { return real({ ...options, command: ${JSON.stringify([process.execPath, native, 'host-tools'])} }); }\n`);
  const manifest = join(dir, 'backbone.module.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), digest: pieceDigest(dir) }));
  return dir;
}
