// Review receipts are local evidence, never permission or executable instructions.
// Binding v1: {version:1,unit,authorSession,authorFamily,review:{verdict:'ACCEPT',
// family,session,reviewedSha,base,patchId,coreDiffHash?,artifact:{path,sha256}},delta?}.
// A delta repeats review's fields, with fromSha/fromPatchId naming the old receipt;
// reviewedSha names the new head. Artifact JSON must repeat those binding headers.
// Artifacts live in ignored regular files under the caller's repository. The queue
// loads their binding explicitly; no author note or test output can grant ACCEPT.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntax, walk, literal, testNames } from './test-source.mjs';

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const HASH = /^[a-f0-9]{64}$/;
const causeClasses = new Set(['integration', 'test-state/flake', 'environment', 'product defect']);
const text = value => typeof value === 'string' && value.trim() && !/[\x00-\x1f]/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function gitBytes(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: 64 * 1024 ** 2, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr?.toString().trim() || result.error?.message || result.status}`);
  return result.stdout;
}
const git = (root, args) => gitBytes(root, args).toString().trim();
const ownBase = (root, base, head) => git(root, ['merge-base', base, head]);
export function ownPatchId(root, base, head) {
  const diff = gitBytes(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', ownBase(root, base, head), head]);
  const result = gitBytes(root, ['patch-id', '--stable'], diff).toString().trim();
  return result ? result.split(/\s+/)[0] : createHash('sha1').update('').digest('hex');
}
export function coreDiffHash(root, base, head) {
  return digest(gitBytes(root, ['diff', base, head, '--', 'packages/core', 'packages/platform/src/composition/core.ts']));
}
function family(value) {
  if (!text(value)) return null;
  const name = value.toLowerCase().trim();
  if (/^(?:gpt|o\d|codex|openai)(?:[-\s\d.]|$)/.test(name)) return 'openai';
  if (/^(?:claude|anthropic)(?:[-\s\d.]|$)/.test(name)) return 'anthropic';
  if (/^(?:gemini|gemma|google)(?:[-\s\d.]|$)/.test(name)) return 'google';
  if (/^(?:qwen|alibaba)(?:[-\s\d.]|$)/.test(name)) return 'qwen';
  if (/^(?:llama|meta)(?:[-\s\d.]|$)/.test(name)) return 'meta';
  if (/^(?:mistral|deepseek|cohere|xai)(?:[-\s\d.]|$)/.test(name)) return name.match(/^[a-z]+/)[0];
  return null;
}
// These files define the oracle, publication and containment. Review is mandatory
// regardless of whether an individual diff happens to contain a security word.
const alwaysReview = file => /^(?:scripts|\.github|deploy)\//.test(file)
  || ['.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs'].includes(file)
  // The complete manifest is reviewed: test commands can delegate through other
  // script names, dependencies and loader configuration, not just scripts.test.
  || /(?:^|\/)package\.json$/.test(file);
const sensitivePath = file => alwaysReview(file) || /(?:^|[/.\-_])(?:authority|secrets?|system-keys|vault|signatures?|mandates?|effects?|permissions?|grants?|capabilities|admission|sandbox|security|credentials?|outbox|connectors?|approvals?|auth|policy)(?:[/.\-_]|$)/i.test(file)
  || /^(?:packages\/(?:core|kernel)\/|packages\/platform\/src\/composition\/core\.ts$)/.test(file)
  || /^scripts\/(?:merge-queue|heavy-slots|with-heavy-lock|gate)/.test(file);
const sensitiveDiff = diff => diff.split('\n').some(line => /^[+-](?![+-])/.test(line) && /\b(?:assertHomeWriteAdmission|withHomeLock|safeStorage|authorization|authorisation|authority|secret|credential|mandate|signature|dispatchEffect|publishCandidate|effectGateway|permission|sandbox|capability|grant|token|oauth|password|encrypt|(?:api|private|signing|secret|encryption|access)[_-]?key)\b/i.test(line));
function verifyReceipt(root, review, authorFamilies, authorSession, delta = false) {
  if (!review || review.verdict !== 'ACCEPT' || !family(review.family) || !text(review.session) || review.session === authorSession || authorFamilies.has(family(review.family))) throw new Error('Review needs an independent cross-family ACCEPT');
  if (!SHA.test(review.reviewedSha || '')) throw new Error('Review needs an exact reviewed SHA');
  if (!review.artifact || !text(review.artifact.path) || !HASH.test(review.artifact.sha256 || '')) throw new Error('Review needs a hashed receipt artifact');
  const base = realpathSync(root), file = resolve(root, review.artifact.path);
  const local = relative(base, file);
  if (local.startsWith('..') || local === '' || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || relative(base, realpathSync(file)).startsWith('..')) throw new Error('Review artifact must be a regular local evidence file');
  if (spawnSync('git', ['check-ignore', '-q', '--no-index', '--', local], { cwd: root, stdio: 'ignore' }).status !== 0) throw new Error('Review artifact must stay in ignored evidence, outside source');
  const bytes = readFileSync(file);
  if (digest(bytes) !== review.artifact.sha256) throw new Error('Review artifact bytes changed');
  let receipt;
  try { receipt = JSON.parse(bytes.toString()); }
  catch { throw new Error('Review artifact is not valid receipt JSON'); }
  for (const field of ['verdict', 'session', 'reviewedSha', ...(delta ? ['fromSha', 'fromPatchId'] : []), ...['patchId', 'base', 'coreDiffHash'].filter(key => review[key] !== undefined)]) if (receipt[field] !== review[field]) throw new Error(`Review artifact does not bind ${field}`);
  if (family(receipt.family) !== family(review.family)) throw new Error('Review artifact family differs');
  return receipt;
}

/** Read immutable Git inputs and validate the supplied local receipt; never mutate a ref. */
export function inspectUnitBinding(root, unit, integrationBase, binding) {
  const result = { accepted: false, reasons: [], head: unit.head, reviewedSha: null, authorSession: unit.session || null, bindingMode: 'not-required', sensitive: false, files: [], patchId: null, coreDiffHash: null };
  try {
    if (!text(unit.session)) throw new Error('Unit needs its authoring session name');
    if (!SHA.test(unit.head || '') || !SHA.test(integrationBase || '')) throw new Error('Unit and integration need exact SHAs');
    const base = ownBase(root, integrationBase, unit.head);
    result.files = git(root, ['diff', '--no-renames', '--name-only', '-z', base, unit.head]).split('\0').filter(Boolean);
    const diff = gitBytes(root, ['diff', '--no-ext-diff', '--no-textconv', base, unit.head]).toString();
    result.patchId = ownPatchId(root, integrationBase, unit.head);
    result.sensitive = result.files.some(sensitivePath) || sensitiveDiff(diff);
    const core = result.files.some(file => file.startsWith('packages/core/') || file === 'packages/platform/src/composition/core.ts');
    if (!binding && !result.sensitive) { result.accepted = true; return result; }
    if (!binding || binding.version !== 1 || binding.unit !== unit.name || binding.authorSession !== unit.session) throw new Error('Missing or mismatched unit review binding');
    const authorFamilies = new Set();
    for (const item of [unit.authorFamily, binding.authorFamily]) { const normalized = family(item); if (normalized) authorFamilies.add(normalized); }
    const messages = git(root, ['log', '--format=%B', `${base}..${unit.head}`]);
    for (const match of messages.matchAll(/^Agent:\s*(.+)$/gm)) { const normalized = family(match[1]); if (normalized) authorFamilies.add(normalized); }
    if (!authorFamilies.size || (unit.authorFamily && binding.authorFamily && family(unit.authorFamily) !== family(binding.authorFamily))) throw new Error('Review binding needs the actual author model family');
    const review = binding.review;
    result.reviewedSha = SHA.test(review?.reviewedSha || '') ? review.reviewedSha : null;
    let attestation = verifyReceipt(root, review, authorFamilies, unit.session);
    if (core && !HASH.test(attestation.coreDiffHash || '')) throw new Error('Reviewer receipt needs its frozen Core diff hash');
    if (!SHA.test(review.base || '')) throw new Error('Review needs its original base SHA');
    const reviewedPatchId = ownPatchId(root, review.base, review.reviewedSha);
    if (review.patchId !== undefined && review.patchId !== reviewedPatchId) throw new Error('Frozen review patch-id differs from its reviewed Git diff');
    // A matching head cannot make an empty/last-commit review cover an earlier
    // authority change. The initial receipt must bind its complete own range,
    // including when a later delta builds on that receipt after a rebase.
    if (reviewedPatchId !== ownPatchId(root, integrationBase, review.reviewedSha)) throw new Error('Review range does not cover the complete unit own diff at its reviewed SHA');
    if (review.reviewedSha === unit.head) result.bindingMode = 'exact-head';
    else if (reviewedPatchId === result.patchId) result.bindingMode = 'unchanged-patch';
    else {
      const delta = binding.delta;
      attestation = verifyReceipt(root, delta, authorFamilies, unit.session, true);
      if (delta.fromSha !== review.reviewedSha || delta.fromPatchId !== reviewedPatchId || delta.reviewedSha !== unit.head || delta.patchId !== result.patchId) throw new Error('Changed unit patch requires a delta ACCEPT bound to the prior receipt and current head');
      result.reviewedSha = delta.reviewedSha; result.bindingMode = 'delta';
    }
    if (core) {
      result.coreDiffHash = coreDiffHash(root, integrationBase, unit.head);
      if (attestation.coreDiffHash !== result.coreDiffHash) throw new Error('Reviewer-attested Core diff hash differs from the live integration-base-to-head Core diff');
    }
    result.accepted = true;
  } catch (error) { result.reasons.push(error.message); }
  return result;
}

function failureContext(metadata) {
  if (!metadata.root) return { root: null, scope: null };
  const root = realpathSync(metadata.root);
  if (['app-e2e', 'app-installed'].includes(metadata.suite)) return { root, scope: 'packages/surfaces/app' };
  let packages = [];
  try { packages = [...workspaceMap(root).values()].filter(pkg => pkg.name === metadata.suite || pkg.name.split('/').at(-1) === metadata.suite); }
  catch { /* An unresolved suite cannot give a relative file an owner. */ }
  return { root, scope: packages.length === 1 ? packages[0].dir : null };
}
function failureFile(path, context) {
  let file = path.trim().replace(/^['"(]+|['")]+$/g, '').replace(/:\d+(?::\d+)?$/, '').replaceAll('\\', '/');
  try { if (file.startsWith('file:')) file = fileURLToPath(file); } catch { return null; }
  const dependency = /(?:^|\/)(?:node_modules|\.pnpm)\//.test(file);
  if (!context.root) return dependency ? undefined : /^(?:packages|scripts|oracle|conformance)\//.test(file) ? file : null;
  if (isAbsolute(file)) file = relative(context.root, file).replaceAll('\\', '/');
  else if (!/^(?:packages|scripts|oracle|conformance)\//.test(file)) {
    // test/ and src/ frames are relative to the selected package, never a
    // basename search across unrelated packages that happen to use that name.
    if (context.scope) file = relative(context.root, resolve(context.root, context.scope, file)).replaceAll('\\', '/');
    else if (/^(?:test|src|e2e)\//.test(file.replace(/^\.\//, ''))) return null;
  }
  const source = resolveSource(context.root, file);
  if (dependency) {
    if (!source) return undefined;
    const canonical = relative(context.root, realpathSync(join(context.root, source))).replaceAll('\\', '/');
    return /^(?:packages|scripts|oracle|conformance)\//.test(canonical) ? canonical : undefined;
  }
  return source || null;
}
function reporterTitle(root, file, raw, separator) {
  const formatted = raw.replace(/\s+[─━-]{3,}\s*$/, '').trim();
  let title = formatted.split(separator).at(-1).trim();
  if (root && file) {
    try {
      // Keep literal reporter separators that are part of a test's own name.
      const declared = testNames(readFileSync(join(root, file), 'utf8')).filter(name => formatted === name || formatted.endsWith(separator + name));
      if (declared.length) title = declared.sort((a, b) => b.length - a.length)[0];
    } catch { /* Dynamic titles retain the reporter's explicit hierarchy. */ }
  }
  const prefix = formatted.slice(0, formatted.length - title.length).replace(new RegExp(`${separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
  return { test: [...prefix.split(separator).map(part => part.trim()).filter(Boolean), title].join(' '), title };
}
function failureReport(log, metadata = {}) {
  const context = failureContext(metadata), found = [], unresolved = [], cases = [];
  const add = raw => { const file = failureFile(raw, context); if (file) found.push(file); else if (file === null && context.root) unresolved.push(raw.replace(/:\d+(?::\d+)?$/, '')); return file; };
  for (const line of String(log || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const playwright = line.match(/^\s*(?:\d+\)\s+|[✘×]\s+\d+\s+)(?:\[([^\]]+)\]\s+›\s+)?(.+?\.[cm]?[jt]sx?):\d+(?::\d+)?\s+›\s+(.+)$/);
    const vitest = line.match(/^\s*FAIL\s+(?:\|([^|\n]+)\|\s+)?(.+?\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?(?:\s+>\s+(.+))?\s*$/);
    if (playwright || vitest) {
      const match = playwright || vitest, file = add(match[2]), runner = playwright ? 'playwright' : 'vitest';
      if (match[3]) {
        const raw = playwright && /^\s*[✘×]/.test(line) ? match[3].replace(/\s+\([\d.]+(?:ms|s|m)\)\s*$/, '') : match[3];
        cases.push({ file, runner, ...reporterTitle(context.root, file, raw, playwright ? ' › ' : ' > '), project: match[1]?.trim() || null });
      }
      continue;
    }
    if (!/(?:\bat\s|location:|file:|❯|✘|×)/.test(line)) continue;
    for (const match of line.matchAll(/(?:file:\/\/)?(?:\/?[\w.@%+-]+\/)+[\w.@%+-]+\.(?:[cm]?[jt]sx?|json|sql)(?::\d+(?::\d+)?)?/g)) add(match[0]);
  }
  const uniqueCases = [...new Map(cases.map(item => [JSON.stringify(item), item])).values()];
  return { files: [...new Set(found)], unresolvedFiles: [...new Set(unresolved)], cases: uniqueCases };
}
/** A timeout alone is not a flake. Only positive environment/test-state evidence grants one retry. */
export function classifyFailure(log, metadata = {}) {
  const source = String(log || '').replace(/\x1b\[[0-9;]*m/g, '');
  const report = failureReport(source, metadata), primary = report.cases.find(item => item.file);
  let causeClass = 'product defect', reason = 'A deterministic or unknown test failure needs product investigation';
  const environment = /\b(?:ENOSPC|ENOMEM|EMFILE|ENFILE|EAGAIN|EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND)\b|no space left on device|could not (?:create|resize|map) shared memory|cannot allocate memory|out of memory|too many (?:open files|connections)|resource temporarily unavailable/i.test(source);
  const flake = /^\s*(?:classification|cause):\s*(?:test-state\/flake|flake)\s*$/mi.test(source) || /\b(?:stale fixture|leftover test data|known flake)\b/i.test(source);
  if (environment || metadata.environment === true) { causeClass = 'environment'; reason = 'Resource or connection evidence indicates an environment failure'; }
  else if (flake || metadata.flake === true) { causeClass = 'test-state/flake'; reason = 'Explicit test-state or known-flake evidence'; }
  else if (/CONFLICT \(|could not apply [a-f0-9]|patch failed|review binding|journey.*(?:schema|judgement|conflict)/i.test(source) || metadata.integration === true) { causeClass = 'integration'; reason = 'Candidate construction or binding failed'; }
  const fallback = report.cases.length ? null : source.match(/^\s*not ok \d+ - (.+)$/m)?.[1] || source.match(/^\s*(?:FAIL|×|✘)\s+(.+)$/m)?.[1] || null;
  return { causeClass, retryable: causeClass === 'environment' || causeClass === 'test-state/flake', reason, ...report, test: primary?.test || fallback, title: primary?.title || fallback, project: primary?.project || null };
}

function localFile(root, file) {
  if (typeof file !== 'string' || file.startsWith('/') || file.split('/').includes('..')) return null;
  const full = resolve(root, file);
  if (!existsSync(full) || !lstatSync(full).isFile() || lstatSync(full).isSymbolicLink() || relative(realpathSync(root), realpathSync(full)).startsWith('..')) return null;
  return file.replaceAll('\\', '/');
}
function resolveSource(root, file) {
  const withoutExtension = file.replace(/\.(?:[cm]?js|jsx)$/, '');
  return [...new Set([file, `${file}.ts`, `${file}.tsx`, `${file}.mjs`, `${file}.js`, `${withoutExtension}.ts`, `${withoutExtension}.tsx`, `${file}/index.ts`, `${file}/index.mjs`, `${file}/index.js`])].map(path => localFile(root, path)).find(Boolean);
}
function workspaceMap(root) {
  const map = new Map();
  for (const file of git(root, ['ls-files', '-z']).split('\0').filter(file => /^packages\/.+\/package\.json$/.test(file))) {
    try { const pkg = JSON.parse(readFileSync(join(root, file), 'utf8')); if (text(pkg.name)) map.set(pkg.name, { dir: dirname(file), ...pkg }); } catch { /* Invalid package declarations cannot resolve an import. */ }
  }
  return map;
}
function sourceGraph(root, start, packages) {
  const drives = new Set(), unknown = [];
  const visit = file => {
    if (drives.has(file)) return;
    if (!localFile(root, file)) { unknown.push(file); return; }
    drives.add(file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const source = readFileSync(join(root, file), 'utf8'), imports = [];
    let ast;
    try { ast = syntax(source); }
    catch { unknown.push(`${file}: source syntax unavailable`); return; }
    const add = (node, kind) => { const value = literal(node); if (value === undefined) unknown.push(`${file}: computed ${kind}`); else imports.push(value); };
    walk(ast, node => {
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) add(node.source, 'import');
      if (node.type === 'ImportExpression') add(node.source, 'import');
      if (node.type === 'TSImportType') add(node.argument, 'type import');
      if (node.type === 'CallExpression' && (node.callee.type === 'Import' || (node.callee.type === 'Identifier' && node.callee.name === 'require') || (node.callee.type === 'MemberExpression' && node.callee.object.name === 'require' && node.callee.property.name === 'resolve'))) add(node.arguments[0], 'import');
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'URL') {
        const base = node.arguments[1];
        if (base?.type === 'MemberExpression' && base.property.name === 'url' && base.object.type === 'MetaProperty' && base.object.meta.name === 'import') add(node.arguments[0], 'URL input');
      }
    });
    for (const specifier of imports) {
      if (specifier.startsWith('.')) {
        const path = relative(root, resolve(root, dirname(file), specifier)).replaceAll('\\', '/');
        const target = resolveSource(root, path); if (target) visit(target); else unknown.push(`${file}: ${specifier}`);
      } else {
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0], pkg = packages.get(name);
        if (!pkg) continue; // Installed external dependencies are not authored source units.
        const subpath = specifier.slice(name.length).replace(/^\//, '');
        const key = subpath ? `./${subpath}` : '.';
        const conditions = pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports) && !Object.keys(pkg.exports).some(name => name.startsWith('.'));
        const exported = typeof pkg.exports === 'string' ? (subpath ? undefined : pkg.exports) : conditions && !subpath ? pkg.exports : pkg.exports?.[key];
        if (pkg.exports !== undefined && exported === undefined) { unknown.push(`${file}: unresolved package export ${specifier}`); continue; }
        const choices = typeof exported === 'string' ? [exported] : exported && typeof exported === 'object' ? Object.values(exported).filter(value => typeof value === 'string') : [];
        if (!subpath && typeof pkg.main === 'string') choices.push(pkg.main);
        if (subpath && !choices.length) choices.push(subpath);
        if (!choices.length) choices.push('index.js');
        const targets = [...new Set(choices.map(choice => resolveSource(root, `${pkg.dir}/${choice.replace(/^\.\//, '')}`)).filter(Boolean))];
        if (targets.length) { drives.add(`${pkg.dir}/package.json`); for (const target of targets) visit(target); } else unknown.push(`${file}: ${specifier}`);
      }
    }
  };
  visit(start); return { drives: [...drives], unknown };
}
/** Per failing file, include only the test and its statically proven driven inputs.
 * Computed/unresolved local imports preserve candidates but prohibit automatic blame.
 * drivenFiles must be a per-failing-file collector map corroborated by this AST
 * graph or diagnostic log locations. A caller assertion cannot manufacture blame.
 */
export function attributeFailingFiles(root, failure, units) {
  const metadata = { root, suite: failure.suite }, parsed = failureReport(failure.log || '', metadata);
  const rawFiles = Array.isArray(failure.files) ? failure.files : Array.isArray(failure.failingFiles) ? failure.failingFiles : parsed.files;
  const files = [...new Set(rawFiles.filter(file => typeof file === 'string'))];
  const mappings = [], candidates = new Set();
  const diagnosticFiles = parsed.files;
  let packages;
  try { packages = workspaceMap(root); } catch { packages = new Map(); }
  for (const file of files) {
    const graph = sourceGraph(root, file, packages);
    const explicit = failure.drivenFiles && !Array.isArray(failure.drivenFiles) ? failure.drivenFiles[file] : undefined;
    if (Array.isArray(explicit)) for (const input of explicit) {
      if (localFile(root, input) && (graph.drives.includes(input) || diagnosticFiles.includes(input))) graph.drives.push(input);
      else graph.unknown.push(`${file}: collector input is unproven`);
    }
    const matching = units.filter(unit => (unit.files || []).some(input => graph.drives.includes(input))).map(unit => unit.name);
    for (const unit of matching) candidates.add(unit);
    mappings.push({ file, drives: [...new Set(graph.drives)], units: matching, complete: graph.unknown.length === 0, unknown: graph.unknown });
  }
  const unresolvedFiles = [...new Set([...(failure.unresolvedFiles || []), ...parsed.unresolvedFiles])];
  const complete = files.length > 0 && !unresolvedFiles.length && mappings.every(mapping => mapping.complete);
  return { mappings, complete, candidates: [...candidates], units: complete ? [...candidates] : [], unassigned: [...unresolvedFiles, ...mappings.filter(mapping => !mapping.units.length).map(mapping => mapping.file)] };
}

function packageScopes(unit) {
  const scopes = new Set();
  if (!Array.isArray(unit.files) || !unit.files.length) return null;
  for (const file of unit.files) {
    const match = file.match(/^packages\/((?:modules|surfaces)\/[^/]+|[^/]+)\//);
    if (!match || sensitivePath(file)) return null;
    scopes.add(`path:${match[1]}`);
  }
  for (const pkg of unit.affectedPackages || unit.packages || []) scopes.add(`package:${pkg}`);
  return scopes;
}
/** Explicit disjoint batching is bounded; serial is the research-backed default. */
export function chooseBatch(units, { mode = 'serial', maxBatch = 3 } = {}) {
  if (!['serial', 'disjoint'].includes(mode)) throw new Error('Unknown queue selection mode');
  if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 3) throw new Error('A small disjoint batch contains one to three units');
  if (!units.length || mode === 'serial') return units.slice(0, 1);
  const result = [], occupied = new Set();
  for (const unit of units) {
    if (result.length >= maxBatch) break;
    const scopes = packageScopes(unit);
    if (!scopes) { if (!result.length) result.push(unit); break; }
    if ([...scopes].some(scope => occupied.has(scope))) break;
    result.push(unit); for (const scope of scopes) occupied.add(scope);
  }
  return result;
}

export function failureEnvelope(unit, failure, testedSha) {
  if (!text(unit.session)) throw new Error('Returned failures need the authoring session name');
  const causeClass = causeClasses.has(failure.causeClass) ? failure.causeClass : 'integration';
  return { ...failure, name: unit.name, authorSession: unit.session, reviewedSha: unit.reviewedSha ?? unit.binding?.reviewedSha ?? null, unitHead: unit.head, testedSha: testedSha || null, causeClass };
}
