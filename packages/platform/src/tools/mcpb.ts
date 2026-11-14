// A Claude Desktop extension bundle (.mcpb, manifest_version 0.3, the shape of the bundles Claude
// Desktop 3.1623 installed on the development Mac) for the door: a zip holding the manifest and a
// small script that starts the door inside the app. Opening it shows Claude's own install dialog, the
// person's second confirmation. Claude Desktop's config file is never written.
import zlib from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data: Buffer): number =>
  typeof zlib.crc32 === 'function' ? zlib.crc32(data) : (data.reduce((c, b) => CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;

/** A zip of stored (uncompressed) files, with Unix modes, at a fixed time so the same content gives the same bytes. */
export function zip(files: { name: string; data: Buffer; mode?: number }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(f.data.length, 18);
    head.writeUInt32LE(f.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, f.data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(f.data.length, 20);
    entry.writeUInt32LE(f.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((((f.mode ?? 0o644) | 0o100000) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += head.length + name.length + f.data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The door's bundle: its server is a script inside the bundle that starts the door inside the app
 * with the grant's name. The only environment it names is the data home.
 */
export function doorBundle(options: { name: string; label: string; version: string; door: string; grant: string; home: string }): Buffer {
  const manifest = {
    manifest_version: '0.3',
    name: options.name,
    display_name: options.label,
    version: options.version,
    description: `Lets Claude act through ${options.label}'s door: each action is checked against the permission you gave there, and gets a receipt.`,
    author: { name: options.label },
    server: {
      type: 'binary',
      entry_point: 'server/door',
      mcp_config: { command: '${__dirname}/server/door', args: ['serve', '--grant', options.grant], env: { BACKBONE_HOME: options.home } },
    },
    compatibility: { platforms: ['darwin'] },
  };
  const script = `#!/bin/sh\n# Starts the door inside the app.\nexec ${quote(options.door)} "$@"\n`;
  return zip([
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: 'server/door', data: Buffer.from(script), mode: 0o755 },
  ]);
}
