// Tool output is read from the built files, rather than inferred from this Node process.
import { execFileSync } from 'node:child_process';
export const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
export function buildEnvironment({ compiler, cxx, sdk, work }) {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC', TMPDIR: work,
    CC: compiler, CXX: cxx, CFLAGS: `-O2 -arch arm64 -arch x86_64 -isysroot ${sdk}`,
    CXXFLAGS: `-O2 -arch arm64 -arch x86_64 -isysroot ${sdk}`, MACOSX_DEPLOYMENT_TARGET: '13.0', CONFIG_SITE: '/dev/null' };
}
export function signatureRecord(status, fingerprint) {
  if (!status.split('\n').some(line => line.startsWith('[GNUPG:] VALIDSIG ') && line.split(' ').includes(fingerprint))) throw new Error('Wrong GNU signature signer.');
  return { verified: true, fingerprint, keyExpired: /^\[GNUPG:\] (?:EXPKEYSIG|KEYEXPIRED) /m.test(status) };
}
export function inspectMachO(file, run = capture) {
  const architectures = run('lipo', ['-archs', file]).split(/\s+/).sort();
  const loads = run('otool', ['-l', file]);
  // Only the deployment load commands count; SDK and ABI versions are separate fields.
  const targets = [...loads.matchAll(/cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\b[\s\S]*?\b(?:minos|version)\s+(\d+\.\d+(?:\.\d+)?)/g)].map(match => match[1]);
  if (!targets.length || targets.some(value => !/^13\.0(?:\.0)?$/.test(value))) throw new Error(`Unexpected macOS deployment target in ${file}.`);
  return { architectures, deploymentTargets: targets };
}
export function assertArchitectures(available, needed) {
  if (!needed.length || needed.some(arch => !available.includes(arch))) throw new Error(`LGPL architecture mismatch: have ${available}, need ${needed}.`);
}
