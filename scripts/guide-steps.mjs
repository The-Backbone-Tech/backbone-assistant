import { testEnvironment } from './lib/test-environment.mjs';
// Guides that run as tests: every ```bash test``` block in docs/distributions.md and docs/how-to/*.md runs here, in order,
// from the repository root. Untagged ```bash``` blocks are shown to people but not run (they need a screen,
// a key or an outside effect). Run alone with `pnpm guides`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listFiles, read } from './lib/repo.mjs';

// Set while a step runs, so a step that runs `pnpm check` does not run the guides again.
export const NESTED = 'BACKBONE_GUIDE_STEP';
const TIMEOUT_MS = 10 * 60 * 1000;

export function guideFiles(files) {
  return files.filter((f) => f === 'docs/distributions.md' || /^docs\/how-to\/[^/]+\.md$/.test(f));
}

export function extractSteps(text) {
  const steps = [];
  let current = null;
  text.split('\n').forEach((line, i) => {
    if (current) {
      if (/^\s*```\s*$/.test(line)) {
        steps.push(current);
        current = null;
      } else current.code.push(line);
      return;
    }
    const open = /^\s*```(\w+)?(.*)$/.exec(line);
    if (!open) return;
    const tagged = ['bash', 'sh'].includes(open[1]) && /(^|\s)test(\s|$)/.test(open[2]);
    current = tagged ? { line: i + 1, code: [] } : { line: i + 1, code: [], skip: true };
  });
  return steps.filter((s) => !s.skip).map((s) => ({ line: s.line, code: s.code.join('\n') }));
}

export function runStep(root, step, env = process.env) {
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', step.code], {
    cwd: root,
    encoding: 'utf8',
    env: { ...testEnvironment(env), [NESTED]: '1', CI: env.CI ?? '1' },
    timeout: TIMEOUT_MS,
  });
  if (r.status === 0) return null;
  // Nested self-tests end with passing checks and a summary. Keep the failed assertion,
  // not just that tail, so a rerun is not needed merely to identify the failing child.
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return `exit ${r.status ?? r.signal}: ${r.error ? `${r.error.message}\n` : ''}${output}`;
}

export function check(root, { env = process.env } = {}) {
  if (env[NESTED]) return [];
  const problems = [];
  for (const file of guideFiles(listFiles(root)).filter((f) => existsSync(join(root, f)))) {
    const steps = extractSteps(read(root, file));
    if (file.startsWith('docs/how-to/') && steps.length === 0) {
      problems.push(`${file}: a how-to needs at least one \`\`\`bash test step that CI runs.`);
    }
    for (const step of steps) {
      const failure = runStep(root, step, env);
      if (failure) {
        problems.push(`${file}:${step.line}: guide step failed (${failure}). Fix the guide or the code it describes.`);
        break;
      }
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = check(process.cwd());
  for (const p of problems) console.log(`- ${p}`);
  console.log(problems.length ? `${problems.length} guide problem(s).` : 'All guide steps passed.');
  process.exit(problems.length ? 1 : 0);
}
