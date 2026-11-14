// Only mechanical joins belong here. Ambiguous source or evidence is returned to its author.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { parse } from '@babel/parser';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => `${typeof value}:${value}`;
const own = (value, key) => Object.hasOwn(value || {}, key) ? value[key] : undefined;
const gitResult = (root, args, options = {}) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, ...options });
function git(root, args, options) {
  const result = gitResult(root, args, options);
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${(result.stderr || result.error?.message || '').trim()}`);
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}
function at(root, head, file) {
  const result = gitResult(root, ['show', `${head}:${file}`]);
  return result.status === 0 ? result.stdout : undefined;
}
function conflict(message) { throw new Error(`Mechanical conflict: ${message}`); }
function judgement(entries, message) {
  const error = new Error(`Journey judgement required: ${message}`);
  error.judgement = entries;
  throw error;
}
function mergeAtomic(base, variants, location) {
  const changes = variants.filter(value => !same(value, base));
  if (changes.some(value => !same(value, changes[0]))) conflict(`competing values at ${location}`);
  return structuredClone(changes.length ? changes[0] : base);
}

function mergeValue(base, variants, location) {
  const changes = variants.filter(value => !same(value, base));
  // Undefined is absence, not an omitted vote: a one-sided deletion must win.
  if (!changes.length) return structuredClone(base);
  if (changes.every(value => same(value, changes[0]))) return structuredClone(changes[0]);
  const all = [base, ...changes].filter(value => value !== undefined);
  if (changes.some(value => value === undefined)) conflict(`delete/edit at ${location}`);
  if (all.every(object)) {
    const keys = [...Object.keys(base || {}), ...[...new Set(changes.flatMap(Object.keys))].filter(key => !Object.hasOwn(base || {}, key)).sort()];
    return Object.fromEntries(keys.map(key => [key, mergeValue(own(base, key), variants.map(value => own(value, key)), `${location}.${key}`)]).filter(([, value]) => value !== undefined));
  }
  if (all.every(Array.isArray) && all.flat().every(value => object(value) && ['string', 'number'].includes(typeof value.id))) {
    const map = array => new Map((array || []).map(entry => [id(entry.id), entry]));
    const original = map(base), maps = variants.map(map), added = new Map(maps.flatMap(value => [...value]));
    const keys = [...original.keys(), ...[...added.keys()].filter(key => !original.has(key)).sort((a, b) => typeof added.get(a).id === 'number' && typeof added.get(b).id === 'number' ? added.get(a).id - added.get(b).id : String(added.get(a).id).localeCompare(String(added.get(b).id), 'en'))];
    return keys.map(key => mergeValue(original.get(key), maps.map(value => value.get(key)), `${location}[${key}]`)).filter(value => value !== undefined);
  }
  // Non-id arrays are one authored value: replacing evidence is not set addition.
  conflict(`competing values at ${location}`);
}
function validateIds(value, location = 'journeys') {
  if (Array.isArray(value)) {
    const seen = new Set();
    for (const entry of value) {
      if (object(entry) && Object.hasOwn(entry, 'id')) {
        const key = id(entry.id); if (seen.has(key)) conflict(`duplicate id ${entry.id} at ${location}`); seen.add(key);
      }
      validateIds(entry, location);
    }
  } else if (object(value)) for (const [key, entry] of Object.entries(value)) validateIds(entry, `${location}.${key}`);
}

function validateJourneys(families) {
  if (!Array.isArray(families) || families.some(f => !object(f) || !['string', 'number'].includes(typeof f.id) || !Array.isArray(f.journeys) || f.journeys.some(j => !object(j) || typeof j.id !== 'string'))) conflict('journeys must be families and entries keyed by id');
}
function oldSchema(entry) {
  // Current provingTest.level describes the proof; it is not the retired journey.level.
  return Object.hasOwn(entry, 'level') ||
    (Object.hasOwn(entry, 'supportingTests') && !Object.hasOwn(entry, 'evidenceRequired')) ||
    (entry.provingTest?.level !== undefined && !['test', 'installed', 'real engine', 'real use'].includes(entry.provingTest.level));
}
const proofLevels = ['test', 'installed', 'real engine', 'real use'];
function weakerLevel(previous, current) {
  if (typeof previous !== 'string' || previous === current) return false;
  return !proofLevels.includes(previous) || !proofLevels.includes(current) || proofLevels.indexOf(current) < proofLevels.indexOf(previous);
}
function checkJourneyChanges(base, variants) {
  const originals = new Map(base.flatMap(f => f.journeys.map(journey => [id(f.id) + '/' + id(journey.id), journey])));
  const pending = [];
  for (const families of variants) for (const family of families) for (const entry of family.journeys) {
    if (same(originals.get(id(family.id) + '/' + id(entry.id)), entry)) continue;
    if (entry.provingTest !== undefined && !object(entry.provingTest)) conflict(`invalid provingTest for ${entry.id}`);
    const previous = originals.get(id(family.id) + '/' + id(entry.id));
    const proofLevel = journey => journey.provingTest ? journey.provingTest.level || (journey.requiresInstalled ? 'installed' : 'test') : undefined;
    if (previous && ((previous.requiresInstalled === true && entry.requiresInstalled !== true)
      || weakerLevel(previous.evidenceRequired, entry.evidenceRequired)
      || weakerLevel(proofLevel(previous), proofLevel(entry))
      || (previous.provingTest && previous.provingTest.scope !== 'partial' && entry.provingTest?.scope === 'partial'))) {
      pending.push({ family: family.id, id: entry.id, previous, entry, reason: 'Dropping an installed guarantee or lowering required/proving evidence needs judgement' });
    }
    if (oldSchema(entry) || (previous && oldSchema(previous))) pending.push({ family: family.id, id: entry.id, previous, reason: 'Align level/supportingTests with evidenceRequired/provingTest explicitly', entry });
    if (entry.requiresInstalled === true) {
      const proof = entry.provingTest;
      const actualInstalled = object(proof) && typeof proof.file === 'string' && /^packages\/surfaces\/app\/e2e\/.+\.(?:electron\.)?spec\.[jt]s$/.test(proof.file) && ['app-e2e', 'app-installed'].includes(proof.suite) && (proof.level === undefined || proof.level === 'installed') && !/fake[-_ ]?agent/i.test(JSON.stringify(proof));
      if (!actualInstalled) pending.push({ family: family.id, id: entry.id, reason: 'requiresInstalled needs an app proving test, never fake-agent evidence', entry });
    }
  }
  if (pending.length) judgement(pending, 'schema alignment or evidence guarantees need a person');
}
function validateJourneyVariants(base, variants) {
  for (const families of [base, ...variants]) { validateJourneys(families); validateIds(families); }
  checkJourneyChanges(base, variants);
}
export function unionJourneys(base, variants = []) {
  validateJourneyVariants(base, variants);
  for (const variant of variants) refuseReorders(base, variant, 'journeys');
  const merged = mergeValue(base, variants, 'journeys');
  // Independent edits can combine a proof with a retained installed declaration.
  // Validate the resulting claim as well as each changed input.
  checkJourneyChanges(base, [merged]);
  return merged;
}

function refuseReorders(base, variant, location) {
  if (Array.isArray(base) && Array.isArray(variant) && [...base, ...variant].every(value => object(value) && Object.hasOwn(value, 'id'))) {
    const originals = new Map(base.map(entry => [id(entry.id), entry]));
    const existing = variant.filter(entry => originals.has(id(entry.id))), retained = new Set(existing.map(entry => id(entry.id)));
    if (!same(base.filter(entry => retained.has(id(entry.id))).map(entry => id(entry.id)), existing.map(entry => id(entry.id)))) {
      conflict(`id-array reorder at ${location}; return ordering to the author`);
    }
    for (const entry of existing) refuseReorders(originals.get(id(entry.id)), entry, `${location}[${id(entry.id)}]`);
  } else if (object(base) && object(variant)) {
    for (const key of Object.keys(variant)) if (Object.hasOwn(base, key)) refuseReorders(base[key], variant[key], `${location}.${key}`);
  }
}

// Span-based rendering keeps untouched compact entries and a no-op round trip byte-exact.
function jsonSpans(text) {
  JSON.parse(text);
  let offset = 0;
  const space = () => { while (/\s/.test(text[offset] || '') && offset < text.length) offset++; };
  function value() {
    space(); const start = offset, children = [], properties = [];
    if (text[offset] === '{') {
      offset++; space();
      while (text[offset] !== '}') {
        const key = value(); space(); offset++; const child = value();
        if (properties.some(property => property.key === key.value)) conflict(`duplicate JSON field ${key.value}`);
        properties.push({ key: key.value, keyStart: key.start, keyEnd: key.end, node: child }); space();
        if (text[offset] !== ',') break;
        offset++; space();
      }
      offset++;
    } else if (text[offset] === '[') {
      offset++; space();
      while (text[offset] !== ']') {
        children.push(value()); space(); if (text[offset] !== ',') break; offset++; space();
      }
      offset++;
    } else if (text[offset] === '"') {
      offset++;
      while (offset < text.length) { const char = text[offset++]; if (char === '\\') offset++; else if (char === '"') break; }
    } else { while (offset < text.length && !/[\s,}\]]/.test(text[offset])) offset++; }
    return { start, end: offset, value: JSON.parse(text.slice(start, offset)), children, properties };
  }
  return value();
}
function renderSpans(text, node, merged) {
  if (same(node.value, merged)) return text.slice(node.start, node.end);
  let entries, extra;
  if (object(node.value) && object(merged)) {
    entries = node.properties.map(property => ({ start: property.keyStart, end: property.node.end,
      render: () => text.slice(property.keyStart, property.node.start) + renderSpans(text, property.node, merged[property.key]), keep: Object.hasOwn(merged, property.key) }));
    const keys = new Set(node.properties.map(property => property.key));
    const colon = node.properties.length ? text.slice(node.properties[0].keyEnd, node.properties[0].node.start) : ':';
    extra = Object.keys(merged).filter(key => !keys.has(key)).map(key => JSON.stringify(key) + colon + JSON.stringify(merged[key]));
  } else if (Array.isArray(node.value) && Array.isArray(merged) && [...node.value, ...merged].every(value => object(value) && ['string', 'number'].includes(typeof value.id))) {
    const desired = new Map(merged.map(value => [id(value.id), value]));
    entries = node.children.map(child => ({ start: child.start, end: child.end,
      render: () => renderSpans(text, child, desired.get(id(child.value.id))), keep: desired.has(id(child.value.id)) }));
    const keys = new Set(node.value.map(value => id(value.id)));
    extra = merged.filter(value => !keys.has(id(value.id))).map(value => JSON.stringify(value));
  } else return JSON.stringify(merged);
  const prefix = text.slice(node.start, entries.length ? entries[0].start : node.start + 1);
  const suffix = text.slice(entries.length ? entries.at(-1).end : node.start + 1, node.end);
  const separator = entries.length > 1 ? text.slice(entries[0].end, entries[1].start) : ',' + prefix.slice(1);
  return prefix + [...entries.filter(entry => entry.keep).map(entry => entry.render()), ...extra].join(separator) + suffix;
}

export function unionJourneyText(baseText, variantTexts = [], { formatText = baseText } = {}) {
  for (const text of [baseText, ...variantTexts, formatText]) jsonSpans(text);
  const base = JSON.parse(baseText), variants = variantTexts.map(text => JSON.parse(text));
  const merged = unionJourneys(base, variants), formatting = JSON.parse(formatText);
  if (same(formatting, merged)) return formatText;
  const node = jsonSpans(formatText);
  return formatText.slice(0, node.start) + renderSpans(formatText, node, merged) + formatText.slice(node.end);
}

function nativeMerge(base, ours, theirs) {
  const directory = mkdtempSync(join(tmpdir(), 'queue-text-'));
  try {
    const files = ['ours', 'base', 'theirs'].map(name => join(directory, name));
    for (const [index, text] of [ours, base, theirs].entries()) writeFileSync(files[index], text);
    const result = spawnSync('git', ['merge-file', '-p', ...files], { encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 });
    if (result.status !== 0) conflict('nonmechanical text overlaps');
    return result.stdout;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const dependencyKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
export function unionDependencyText(baseText, oursText, theirsText) {
  const values = [baseText, oursText, theirsText].map(text => JSON.parse(text));
  const maps = {};
  for (const key of dependencyKeys) {
    const present = values.map(value => value[key]).filter(value => value !== undefined);
    if (present.some(value => !object(value) || Object.values(value).some(version => typeof version !== 'string'))) conflict(`invalid ${key}`);
    if (!present.length) continue;
    const merged = Object.fromEntries([...new Set(present.flatMap(Object.keys))].sort().map(name =>
      [name, mergeValue(own(values[0][key], name), values.slice(1).map(value => own(value[key], name)), `dependency version for ${name}`)]).filter(([, value]) => value !== undefined));
    // Preserve an explicit empty map, but honour deletion of the entire map.
    if (Object.keys(merged).length || values.slice(1).every(value => value[key] !== undefined)) maps[key] = merged;
  }

  const stripped = values.map(value => Object.fromEntries(Object.entries(value).filter(([key]) => !dependencyKeys.includes(key))));
  const other = JSON.parse(nativeMerge(...stripped.map(value => JSON.stringify(value, null, 2) + '\n')));
  const keys = [...Object.keys(values[1]), ...Object.keys(other).filter(key => !Object.hasOwn(values[1], key)), ...Object.keys(maps).filter(key => !Object.hasOwn(values[1], key))];
  const result = Object.fromEntries([...new Set(keys)].filter(key => Object.hasOwn(maps, key) || Object.hasOwn(other, key)).map(key => [key, Object.hasOwn(maps, key) ? maps[key] : other[key]]));
  const indent = oursText.match(/\n([ \t]+)"/)?.[1];
  return JSON.stringify(result, null, indent || undefined) + (oursText.endsWith('\n') ? '\n' : '');
}

function ast(text) { return parse(text, { sourceType: 'module', plugins: ['typescript'], ranges: true }); }
function importBlock(text) {
  const tree = ast(text), nodes = tree.program.body.filter(node => node.type === 'ImportDeclaration');
  if (!nodes.length) return { nodes, start: 0, end: 0 };
  const start = nodes[0].start, end = nodes.at(-1).end;
  if (tree.program.body.some(node => node.start >= start && node.end <= end && node.type !== 'ImportDeclaration') || tree.comments.some(comment => comment.start >= start && comment.end <= end)) conflict('import block includes authored code or comments');
  return { nodes, start, end };
}
export function unionImportText(baseText, oursText, theirsText) {
  const texts = [baseText, oursText, theirsText], blocks = texts.map(importBlock), groups = new Map(), locals = new Map();
  const snapshots = blocks.map((block, index) => {
    const bindings = new Map();
    for (const declaration of block.nodes) {
      if (declaration.attributes?.length || declaration.assertions?.length) conflict('import attributes need review');
      const source = declaration.source.value, kind = declaration.importKind || 'value', groupKey = JSON.stringify([source, kind]);
      if (!groups.has(groupKey)) groups.set(groupKey, { source, kind, bindings: new Map(), quote: texts[index][declaration.source.start] });
      if (!declaration.specifiers.length) bindings.set(JSON.stringify([source, null]), { groupKey, sideEffect: true });
      for (const specifier of declaration.specifiers) {
        const imported = specifier.type === 'ImportSpecifier' ? specifier.imported.name ?? specifier.imported.value : specifier.type;
        bindings.set(JSON.stringify([source, specifier.local.name]), { groupKey, local: specifier.local.name, imported,
          type: specifier.type, kind: specifier.importKind || 'value', importedRaw: specifier.imported ? texts[index].slice(specifier.imported.start, specifier.imported.end) : undefined });
      }
    }
    return bindings;
  });
  for (const key of new Set(snapshots.flatMap(snapshot => [...snapshot.keys()]))) {
    const binding = mergeAtomic(snapshots[0].get(key), snapshots.slice(1).map(snapshot => snapshot.get(key)), `import binding ${key}`);
    if (!binding) continue;
    const group = groups.get(binding.groupKey);
    if (binding.sideEffect) { group.sideEffect = true; continue; }
    const signature = JSON.stringify([binding.groupKey, binding.imported, binding.kind]);
    if (locals.has(binding.local) && locals.get(binding.local) !== signature) conflict(`import binding ${binding.local}`);
    locals.set(binding.local, signature); group.bindings.set(binding.local, binding);
  }
  const marker = placeholder(texts, value => `/* queue import block ${value} */`);
  const body = nativeMerge(...texts.map((text, index) => text.slice(0, blocks[index].start) + marker + (blocks[index].nodes.length ? '' : '\n') + text.slice(blocks[index].end)));
  if (body.split(marker).length !== 2) conflict('ambiguous import block position');
  const quote = (value, char) => char === "'" ? "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'" : JSON.stringify(value);
  const imports = [...groups.values()].flatMap(group => {
    const all = [...group.bindings.values()].sort((a, b) => a.local.localeCompare(b.local, 'en'));
    const defaults = all.filter(binding => binding.type === 'ImportDefaultSpecifier'), namespaces = all.filter(binding => binding.type === 'ImportNamespaceSpecifier'), named = all.filter(binding => binding.type === 'ImportSpecifier');
    const members = [...defaults.map(binding => binding.local), ...namespaces.map(binding => `* as ${binding.local}`)];
    if (named.length) members.push(`{ ${named.map(binding => `${binding.kind === 'type' ? 'type ' : ''}${binding.importedRaw}${binding.local === binding.imported ? '' : ` as ${binding.local}`}`).join(', ')} }`);
    if (!members.length) return group.sideEffect ? [group.kind === 'type' ? `import type {} from ${quote(group.source, group.quote)};` : `import ${quote(group.source, group.quote)};`] : [];
    return members.map(member => `import${group.kind === 'type' ? ' type' : ''} ${member} from ${quote(group.source, group.quote)};`);
  }).join('\n');
  return body.replace(marker, () => imports);
}
function installedLiteral(text) {
  const tree = ast(text);
  const declarations = tree.program.body.flatMap(node => node.type === 'ExportNamedDeclaration' ? node.declaration?.declarations || [] : node.declarations || []).filter(node => node.id?.name === 'INSTALLED_TEST_ARGS');
  let init = declarations[0]?.init;
  while (init?.type === 'TSAsExpression' || init?.type === 'TSSatisfiesExpression') init = init.expression;
  if (declarations.length !== 1 || init?.type !== 'ArrayExpression') conflict('INSTALLED_TEST_ARGS shape');
  const literals = init.elements.filter(node => node?.type === 'StringLiteral' && /^e2e\/\(\?:/.test(node.value));
  if (literals.length !== 1) conflict('installed regex shape');
  const literal = literals[0], match = /^e2e\/\(\?:([^()]*)\)(.*)$/.exec(literal.value);
  if (!match || match[1].split('|').some(part => !part)) conflict('installed alternation needs judgement');
  return { node: literal, alternatives: match[1].split('|'), suffix: match[2] };
}
export function unionInstalledArgsText(baseText, oursText, theirsText) {
  const texts = [baseText, oursText, theirsText], literals = texts.map(installedLiteral);
  if (!literals.every(value => value.suffix === literals[0].suffix)) conflict('installed regex suffix');
  const alternatives = [...literals[0].alternatives, ...[...new Set(literals.flatMap(value => value.alternatives))].filter(value => !literals[0].alternatives.includes(value)).sort()];
  const marker = placeholder(texts, value => `'queue-installed-regex-${value}'`);
  const body = nativeMerge(...texts.map((text, index) => text.slice(0, literals[index].node.start) + marker + text.slice(literals[index].node.end)));
  if (body.split(marker).length !== 2) conflict('ambiguous installed regex position');
  const value = `e2e/(?:${alternatives.join('|')})${literals[0].suffix}`, quote = oursText[literals[1].node.start];
  const rendered = quote === "'" ? "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'" : JSON.stringify(value);
  return body.replace(marker, () => rendered);
}
export function unionTypeScriptText(base, ours, theirs) {
  const texts = [base, ours, theirs];
  if (texts.every(text => text.includes('INSTALLED_TEST_ARGS'))) {
    // Mask the regex while joining imports so two independent mechanical blocks can
    // coexist. All remaining executable text still goes through Git's three-way merge.
    const literals = texts.map(installedLiteral);
    const minimal = texts.map((text, index) => `export const INSTALLED_TEST_ARGS = [${text.slice(literals[index].node.start, literals[index].node.end)}];\n`);
    const joined = unionInstalledArgsText(...minimal), literal = installedLiteral(joined).node;
    const marker = placeholder(texts, value => `'queue-combined-installed-${value}'`);
    const masked = texts.map((text, index) => text.slice(0, literals[index].node.start) + marker + text.slice(literals[index].node.end));
    const body = unionImportText(...masked);
    if (body.split(marker).length !== 2) conflict('ambiguous combined installed regex');
    return body.replace(marker, () => joined.slice(literal.start, literal.end));
  }
  return unionImportText(base, ours, theirs);
}

const readmeBegin = '<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->';
const readmeEnd = '<!-- end of generated block -->';
function placeholder(texts, render) {
  let value = 0;
  while (texts.some(text => text.includes(render(value)))) value++;
  return render(value);
}
function generatedReadme(base, ours, theirs) {
  const texts = [base, ours, theirs], marker = placeholder(texts, value => `<!-- queue generated block ${value} -->`), blocks = texts.map(text => {
    const start = text.indexOf(readmeBegin), end = text.indexOf(readmeEnd);
    if (start < 0 || end < start || text.indexOf(readmeBegin, start + 1) !== -1) conflict('README generated block boundaries');
    return { start, end: end + readmeEnd.length };
  });
  const merged = nativeMerge(...texts.map((text, index) => text.slice(0, blocks[index].start) + marker + text.slice(blocks[index].end)));
  if (merged.split(marker).length !== 2) conflict('ambiguous generated block position');
  return merged.replace(marker, () => theirs.slice(blocks[2].start, blocks[2].end));
}
export function generatedPaths(root) {
  const paths = new Set(['.dockerignore', 'pnpm-lock.yaml', 'packages/core/schema/current.json']);
  const owner = join(root, 'packages/core/scripts/closed-version.mjs');
  if (existsSync(owner)) {
    const text = readFileSync(owner, 'utf8'), mapping = text.match(/const\s+RUNTIME_RELEASE_FILES\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] || '';
    for (const match of mapping.matchAll(/["'](packages\/core\/[^"']+\.generated\.ts)["']/g)) paths.add(match[1]);
  }
  return paths;
}
function mechanicalText(root, file, base, ours, theirs) {
  if ([ours, theirs].some(text => text === undefined)) conflict(`delete/add conflict in ${file}`);
  if (generatedPaths(root).has(file)) return theirs;
  if (file.endsWith('/backbone.module.json')) {
    const strip = text => { const { digest, version, licence, kind, dependsOn, ...authored } = JSON.parse(text); return { authored, annotations: (dependsOn || []).filter(entry => Object.hasOwn(entry, 'licence')).map(entry => ({ name: entry.name, version: entry.version, licence: entry.licence })) }; };
    if (!same(strip(ours), strip(theirs))) conflict(`authored manifest declaration in ${file}`);
    return theirs;
  }
  if (file.endsWith('README.md') && [ours, theirs].every(text => text.includes(readmeBegin))) return generatedReadme(base ?? readmeBegin + '\n' + readmeEnd, ours, theirs);
  if (file === 'package.json' || file.endsWith('/package.json')) return unionDependencyText(base ?? '{}', ours, theirs);
  if (file.endsWith('.ts')) {
    return unionTypeScriptText(base ?? '', ours, theirs);
  }
  conflict(file);
}
function writeOwned(root, file, text) {
  const actual = realpathSync(dirname(join(root, file))), inside = relative(realpathSync(root), actual);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('../')) conflict(`path escapes candidate: ${file}`);
  writeFileSync(join(root, file), text);
  git(root, ['add', '--', file]);
}

export function cherryPickUnit(root, unit, { base } = {}) {
  const start = git(root, ['rev-parse', 'HEAD']);
  if (git(root, ['status', '--porcelain'])) throw new Error('Cherry-pick candidate must be clean');
  const fork = git(root, ['merge-base', unit.head, base || start]);
  const commits = git(root, ['rev-list', '--reverse', '--topo-order', `${fork}..${unit.head}`]).split('\n').filter(Boolean);
  const generated = generatedPaths(root);
  let needsRelock = false;
  const picked = [];
  const rollback = result => { gitResult(root, ['cherry-pick', '--quit']); git(root, ['reset', '--hard', start]); return { head: start, picked: [], needsRelock: false, conflicts: [], ...result }; };
  for (const commit of commits) {
    if (git(root, ['rev-list', '--parents', '-n', '1', commit]).split(' ').length !== 2) return rollback({ judgement: [{ commit, reason: 'A merge/root commit needs an explicit mainline decision' }], reason: 'Nonlinear unit range needs judgement' });
    if (!git(root, ['show', '-s', '--format=%(trailers:key=Agent,valueonly)', commit])) return rollback({ judgement: [{ commit, reason: 'Source commit lacks an Agent trailer' }], reason: 'Agent trailer required before stacking' });
  }
  for (const commit of commits) {
    const parent = git(root, ['rev-parse', `${commit}^`]), before = git(root, ['rev-parse', 'HEAD']);
    const files = git(root, ['diff', '--name-only', '-z', parent, commit]).split('\0').filter(Boolean);
    needsRelock ||= files.some(file => file === 'pnpm-lock.yaml' || file === 'package.json' || file.endsWith('/package.json'));
    const result = gitResult(root, ['cherry-pick', '--no-commit', commit]);
    const unresolved = git(root, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean), rejected = [];
    if (result.status !== 0 && !unresolved.length) return rollback({ reason: `Cherry-pick failed: ${(result.stderr || result.stdout).trim()}`, conflicts: files });
    let journeyText;
    try {
      if (files.includes('docs/journeys.json')) {
        const ancestor = at(root, parent, 'docs/journeys.json') || '[]\n', ours = at(root, before, 'docs/journeys.json') || '[]\n', theirs = at(root, commit, 'docs/journeys.json') || '[]\n';
        // Clean picks keep Git's exact deletion/replacement result; only unresolved
        // paths need a three-way join. Schema admission still checks every edit.
        validateJourneyVariants(JSON.parse(ancestor), [JSON.parse(theirs)]);
        if (unresolved.includes('docs/journeys.json')) journeyText = unionJourneyText(ancestor, [ours, theirs], { formatText: ours });
        else if (existsSync(join(root, 'docs/journeys.json'))) validateJourneyVariants(JSON.parse(ours), [JSON.parse(readFileSync(join(root, 'docs/journeys.json'), 'utf8'))]);
      }
      for (const file of unresolved) {
        if (file === 'docs/journeys.json' && journeyText !== undefined) continue;
        try {
          const modes = git(root, ['ls-files', '-u', '--', file]).split('\n').filter(Boolean).map(line => line.split(' ')[0]);
          if (modes.some(mode => !['100644', '100755'].includes(mode)) || new Set(modes).size !== 1) conflict(`nonregular or competing mode conflict ${file}`);
          writeOwned(root, file, mechanicalText(root, file, at(root, parent, file), at(root, before, file), at(root, commit, file)));
        } catch { rejected.push(file); }
      }
      if (rejected.length) return rollback({ conflicts: rejected.sort(), reason: 'Nonmechanical conflict; return to author' });
      if (journeyText !== undefined) writeOwned(root, 'docs/journeys.json', journeyText);
    } catch (error) { return rollback({ conflicts: ['docs/journeys.json'], judgement: error.judgement, reason: error.message }); }
    if (git(root, ['diff', '--cached', '--name-only', '-z'])) {
      // Reuse the reviewed unit's author/message; the configured commit-msg hook still runs.
      const agent = git(root, ['show', '-s', '--format=%(trailers:key=Agent,valueonly)', commit]).split('\n').at(-1);
      try { git(root, ['-c', 'trailer.Agent.where=end', '-c', 'trailer.Agent.ifexists=replace', 'commit', '-s', '-C', commit, '--trailer', `Agent: ${agent}`]); }
      catch (error) { return rollback({ conflicts: files, reason: `Commit hook or cherry-pick commit failed: ${error.message}` }); }
    }
    gitResult(root, ['cherry-pick', '--quit']);
    picked.push({ source: commit, head: git(root, ['rev-parse', 'HEAD']) });
  }
  return { head: git(root, ['rev-parse', 'HEAD']), conflicts: [], picked, needsRelock, needsRegeneration: commits.some(commit => git(root, ['diff', '--name-only', `${commit}^`, commit]).split('\n').some(file => generated.has(file) || file.endsWith('/backbone.module.json'))) };
}
