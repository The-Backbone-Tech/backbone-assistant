// Reviewed opaque payloads need byte identity as well as a package's declared closure.
import { copyFileSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { filesBelow, hash } from './notices.mjs';

export function payloadDigest(root, { exclude = [] } = {}) {
  const omitted = new Set(exclude);
  return hash(filesBelow(root).filter(file => !omitted.has(relative(root, file))).map(file => `${relative(root, file)}\0${hash(readFileSync(file))}\n`).join(''));
}
export function verifyReviewedPayload(root, expected, label, options) {
  if (!expected || payloadDigest(root, options) !== expected) throw new Error(`Review notices for changed ${label} payload.`);
}

/** Resolve only the publisher's declared native aliases into reviewed, self-contained bytes. */
export function prepareNativePayload(root, expected) {
  root = resolve(root);
  if (!lstatSync(root).isDirectory()) throw new Error('Native staging root must be a regular directory.');
  const manifest = join(root, 'pg-symlinks.json');
  if (!lstatSync(manifest).isFile()) throw new Error('Native alias manifest must be a staged regular file.');
  const inside = file => {
    const local = relative(root, file);
    if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('Native alias escapes the staged payload.');
    return local;
  };
  const records = JSON.parse(readFileSync(manifest, 'utf8')).map(({ source, target }) => {
    const from = resolve(dirname(root), source), to = resolve(dirname(root), target);
    return { from, to, source: inside(from), target: inside(to) };
  });
  const aliases = new Set(records.map(record => record.target));
  const checkLinks = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() && !aliases.has(relative(root, path))) throw new Error('Unreviewed native symbolic link.');
      if (entry.isDirectory()) checkLinks(path);
    }
  };
  checkLinks(root);
  // The manifest is part of the reviewed digest. Its aliases add no new publisher
  // bytes; exclude their copied forms so the same review covers hydrated installs.
  verifyReviewedPayload(root, expected, 'PostgreSQL native', { exclude: [...aliases] });
  for (const record of records) {
    if (!lstatSync(record.from).isFile()) throw new Error('Native alias source is not a reviewed regular file.');
    rmSync(record.to, { force: true });
    copyFileSync(record.from, record.to);
  }
}
