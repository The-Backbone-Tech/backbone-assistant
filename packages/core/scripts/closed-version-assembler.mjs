// Closed build assembly. Native catalogue verification, installation and runtime admission are separate.
import {createHash} from 'node:crypto';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
const hex = /^[a-f0-9]{64}$/;
const versionPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]*$/;
const roles = new Set(['backbone_gov','backbone_owner']);
function refuse(code) { throw new Error(code); }
function exactKeys(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) refuse(code);
}
function pathIsClosed(path) {
  return typeof path === 'string' && /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\.sql$/.test(path);
}

/** Sources are raw bytes, never a directory wildcard. Prerequisites and prior object ownership
 * are caller-supplied trusted BUILD inputs, not values learned from an installed database.
 * Object declarations still need the owning SQL-definition parser and native profile review. */
export function assembleClosedVersion(manifest, sources, prerequisites, priorObjects, released) {
  exactKeys(manifest,['format','version','requires','sections','changes','checksum'],'manifest fields');
  if (manifest.format !== 1 || !versionPattern.test(manifest.version)) refuse('manifest version');
  if (!Array.isArray(manifest.requires) || manifest.requires.length !== prerequisites.length) refuse('prerequisite order');
  for (let i=0;i<manifest.requires.length;i++) {
    const row=manifest.requires[i];
    exactKeys(row,['version','checksum'],'prerequisite fields');
    if (!hex.test(row.checksum) || row.version !== prerequisites[i].version || row.checksum !== prerequisites[i].checksum)
      refuse('prerequisite order');
  }
  if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) refuse('sections empty');
  const files=new Map();
  for (const section of manifest.sections) {
    exactKeys(section,['role','files'],'section fields');
    if (!roles.has(section.role)) refuse('owning role');
    if (!Array.isArray(section.files) || section.files.length === 0) refuse('section empty');
    for (const row of section.files) {
      exactKeys(row,['path','sha256'],'file fields');
      if (!pathIsClosed(row.path)) refuse('closed source path');
      if (files.has(row.path)) refuse('duplicate source');
      if (!hex.test(row.sha256)) refuse('source digest shape');
      files.set(row.path,{...row,role:section.role});
    }
  }
  if (!(sources instanceof Map) || sources.size !== files.size || [...sources.keys()].some(path=>!files.has(path)))
    refuse('unlisted or missing source');
  for (const [path,row] of files) {
    const bytes=sources.get(path);
    if (!Buffer.isBuffer(bytes)) refuse('source bytes');
    if (bytes.length > 1_000_000 || bytes.toString('utf8').split('\n').length > 1500) refuse('source size');
    if (sha256(bytes) !== row.sha256) refuse('raw source digest');
  }
  if (!Array.isArray(manifest.changes) || manifest.changes.length === 0) refuse('changes empty');
  const changed=new Set(), declaredFiles=new Set(), current=new Map(priorObjects);
  for (const row of manifest.changes) {
    exactKeys(row,['action','object','file'],'object declaration fields');
    // Identity is exact, including function argument types, as determined by the owning parser.
    if (typeof row.object !== 'string' || row.object.length === 0 || row.object.includes('\0')) refuse('object identity');
    if (changed.has(row.object)) refuse('duplicate object');
    changed.add(row.object);
    if (!files.has(row.file)) refuse('object source missing');
    declaredFiles.add(row.file);
    if (row.action === 'add') {
      if (priorObjects.has(row.object)) refuse('add existing object');
    } else if (row.action === 'replace') {
      if (!priorObjects.has(row.object)) refuse('replace absent object');
    } else refuse('object action');
    current.set(row.object,{version:manifest.version,file:row.file});
  }
  if (declaredFiles.size !== files.size) refuse('source lacks declaration');
  const parts=[`-- Core schema version ${manifest.version} (closed build artifact).`];
  for (const section of manifest.sections) {
    parts.push(`SET ROLE ${section.role};`);
    for (const row of section.files) parts.push(`-- ${row.path}`,sources.get(row.path).toString('utf8').replace(/\r\n/g,'\n').trim());
  }
  parts.push('RESET ROLE;');
  const sql=parts.join('\n\n')+'\n', checksum=sha256(sql);
  if (!hex.test(manifest.checksum) || manifest.checksum !== checksum) refuse('payload checksum');
  if (released && (released.version !== manifest.version || released.checksum !== checksum)) refuse('released checksum');
  const manifestSha256=sha256(canonical(manifest));
  if (released && released.manifestSha256 !== manifestSha256) refuse('released manifest');
  // A generated literal has no runtime source-folder dependency and accepts no DDL options.
  const artifact=`// Generated release data. Canonical SQL belongs to the closed version sources.\nexport const MATERIAL_CLOSURE_RELEASE = Object.freeze(${JSON.stringify({version:manifest.version,checksum,manifestSha256,sql})} as const);\n`;
  return {version:manifest.version,checksum,manifestSha256,sql,artifact,current:[...current.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)};
}
