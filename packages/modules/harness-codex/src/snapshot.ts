// Trusted inline program, executed by the pinned native sandbox, never from a staged script.
// Directory/symlink races therefore cannot turn host-side traversal into unrestricted reads.
export const SNAPSHOT_PROGRAM = String.raw`
// backbone-native-snapshot-v1
const fs = require('node:fs');
const path = require('node:path');
// Linux seccomp denies socket-name queries. Node can classify inherited stdio sockets as
// unknown and replace process.stdout/stderr with black holes. Write the granted descriptors.
function emit(fd, text) {
  const data = Buffer.from(text); let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) throw Error('snapshot output refused');
    offset += written;
  }
}
const root = fs.realpathSync(process.cwd());
const files = [], inspection = []; let entries = 0, bytes = 0;
function walk(dir, prefix) {
  const handle = fs.opendirSync(dir);
  try {
    let entry;
    while ((entry = handle.readSync())) {
      // Reserved by the host for shell temporaries; never traverse or import its contents.
      if (!prefix && entry.name === '.backbone-tmp') continue;
      if (++entries > 600) throw Error('snapshot entry limit');
      const name = prefix ? prefix + '/' + entry.name : entry.name;
      if (name.length > 500) throw Error('snapshot name limit');
      const target = path.join(dir, entry.name);
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink()) throw Error('snapshot symbolic link');
      if (!fs.realpathSync(target).startsWith(root + path.sep)) throw Error('snapshot path escaped');
      if (st.isDirectory()) { walk(target, name); continue; }
      if (!st.isFile() || st.nlink !== 1 || st.size > 2000000) throw Error('snapshot invalid file');
      const targetFiles = /^\.backbone-source-data-[a-f0-9]{32}(?:\/|$)/.test(name) ? inspection : files;
      if (targetFiles.length >= (targetFiles === inspection ? 201 : 200)) throw Error('snapshot file limit');
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.ino !== BigInt(st.ino) || before.dev !== BigInt(st.dev)) throw Error('snapshot identity changed');
        const data = fs.readFileSync(fd);
        const after = fs.fstatSync(fd, { bigint: true });
        if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size) throw Error('snapshot changed');
        bytes += data.length;
        if (data.length > 2000000 || bytes > 10000000 || data.includes(0)) throw Error('snapshot text limit');
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
        targetFiles.push({ name, base64: data.toString('base64') });
      } finally { fs.closeSync(fd); }
    }
  } finally { handle.closeSync(); }
}
try { if (process.versions.electron) throw Error('standalone Node required'); walk(root, ''); files.sort((a,b) => a.name.localeCompare(b.name, 'en')); emit(1, JSON.stringify({ files, inspection })); }
catch { emit(2, 'Native staged snapshot refused.'); process.exitCode = 1; }
`;
