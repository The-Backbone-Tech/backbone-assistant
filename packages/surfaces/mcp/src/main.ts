#!/usr/bin/env node
// backbone-mcp: serve the MCP door over stdio; or, for the person outside any door, keep a home's
// doors (host) and grant or revoke one.
//   backbone-mcp serve  --home <data home> --grant <door>
//   backbone-mcp host   --home <data home>
//   backbone-mcp grant  --home <data home> --name <door> --operations outbox.write --ceiling 3 [--days 30]
//   backbone-mcp revoke --home <data home> --name <door>
// The door (serve) holds no secret and opens no database: it relays its calls to the process that
// holds the home's keys: the app for Electron safeStorage, or `host` for system-store keys
// (and explicitly chosen plaintext homes). Standalone grant/revoke use that home's provider;
// Electron safeStorage homes still need the app. Only host may create a new home.
// Its effects go over the door's socket under the grant; its reads over the api line, which `host`
// serves as the app does but with nobody to ask, so with reads and Stop only and no send
// (docs/adr/0002-api-line.md).
// In serve mode stdout carries MCP messages only; everything else goes to stderr.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// The door's own folder, which a host checks against the registration a grant is bound to: a
// checkout's, or the copy an app ships. An app that ships the door also names its core baseline and
// PostgreSQL binaries (paths only), for `host`, `grant` and `revoke`; a checkout builds the baseline.
const piece = fileURLToPath(new URL('..', import.meta.url));

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: 'string', default: process.env.BACKBONE_HOME },
    grant: { type: 'string', default: process.env.BACKBONE_DOOR_GRANT },
    name: { type: 'string' },
    operations: { type: 'string', default: 'outbox.write' },
    ceiling: { type: 'string', default: '3' },
    days: { type: 'string', default: '30' },
  },
});

const fail = (message: string): never => {
  process.stderr.write(`backbone-mcp: ${message}\n`);
  process.exit(2);
};
const home = values.home ?? fail('name the data home with --home or BACKBONE_HOME.');

/** Headless keys follow the vault's recorded provider; a fresh home defaults to the system store. */
async function core() {
  const { chooseKeys } = await import('@backbone-next/platform/system-keys');
  return {
    baselineSql: process.env.BACKBONE_BASELINE_FILE ? readFileSync(process.env.BACKBONE_BASELINE_FILE, 'utf8') : undefined,
    postgresNative: process.env.BACKBONE_POSTGRES_NATIVE || undefined,
    keys: await asPerson(() => chooseKeys(home, process.env, undefined, { create: positionals[0] === 'host' })),
  };
}
/** A refusal of the home's keys is said plainly; anything else is an error as it is. */
async function asPerson<T>(fn: () => Promise<T>): Promise<T> {
  const { KeysRefused } = await import('@backbone-next/platform/keys');
  const { CoreCloseWaitRefusal } = await import('@backbone-next/platform/composition/gateway');
  try {
    return await fn();
  } catch (error) {
    if (error instanceof KeysRefused) fail(error.message);
    if (error instanceof CoreCloseWaitRefusal) fail(error.message);
    throw error;
  }
}

switch (positionals[0]) {
  case 'serve': {
    const grant = values.grant ?? fail('name the door grant with --grant or BACKBONE_DOOR_GRANT.');
    const { connectDoor, NOT_RUNNING } = await import('@backbone-next/platform/doors');
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    const { createDoorServer, readsOver } = await import('./server.ts');
    const gateway = connectDoor({ home, grant });
    // Said once at start; each call says it again until the app is up, and then the door connects by itself.
    const state = await gateway.ready();
    if (state === 'not-running') process.stderr.write(`backbone-mcp: ${NOT_RUNNING.detail}\n`);
    else if (state !== 'ready') fail(state.detail);
    // serveStdio settles the era: 2026-07-28 for a client that probes with server/discover, the 2025
    // handshake for one that does not. The same tools serve both.
    const handle = serveStdio(() => createDoorServer(gateway, readsOver(home)), { onerror: (e) => process.stderr.write(`backbone-mcp: ${e.message}\n`) });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await handle.close().catch(() => {});
      await gateway.close();
      process.exit(0);
    };
    process.stdin.on('end', close);
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
    break;
  }
  case 'host': {
    const { createHost, hostClosed } = await import('@backbone-next/platform/composition');
    const { serveApiLine } = await import('@backbone-next/platform/composition/api-line');
    const { doorSocket } = await import('@backbone-next/platform/doors');
    const { Vault } = await import('@backbone-next/platform/keys');
    const options = await core();
    // The keys first, as before anything else is held: a home the app keeps is refused in plain words.
    await asPerson(() => Vault.open(home, options.keys));
    // A host as the app's, holding the home and serving its doors; its turns run on the stub engine
    // unless the home or BACKBONE_HARNESS names another.
    const host = createHost({ home, ...options, doors: { piece } });
    const closeHost = async () => {
      host.close();
      await hostClosed(home);
    };
    try {
      await asPerson(() => host.call('projects.list', {}));
    } catch (error) {
      await closeHost().catch(() => {});
      fail(error instanceof Error ? error.message : String(error));
    }
    // The doors are served once the core is up; wait for them, so a door started next finds them.
    const { createConnection } = await import('node:net');
    const answers = () => new Promise<boolean>((resolve) => {
      const probe = createConnection(doorSocket(home));
      probe.once('connect', () => (probe.destroy(), resolve(true)));
      probe.once('error', () => resolve(false));
    });
    for (let i = 0; i < 400 && !(await answers()); i++) await new Promise((r) => setTimeout(r, 25));
    if (!(await answers())) {
      await closeHost().catch(() => {});
      fail('Another process already serves this data home\'s doors.');
    }
    // No confirm: nobody is here to ask, so the line carries reads and Stop, and no send.
    const line = await serveApiLine({ home, call: (method, args) => host.call(method, args) });
    process.stdout.write(`Serving the doors of ${home}; stop with Ctrl-C.\n`);
    setInterval(() => {}, 60_000); // The line does not keep a process alive; this host's own life does.
    const stop = async () => {
      await line.close().catch(() => {});
      await closeHost();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    break;
  }
  case 'grant': {
    const name = values.name ?? fail('name the door with --name.');
    const { grantDoor } = await import('@backbone-next/platform/composition/gateway');
    const options = await core();
    const g = await asPerson(() =>
      grantDoor({ home, name, piece, ...options, operations: values.operations.split(',').map((s) => s.trim()).filter(Boolean), ceiling: Number(values.ceiling), days: Number(values.days) }),
    );
    process.stdout.write(`Granted door "${g.name}": ${g.operations.join(', ')} up to class ${g.ceiling}, until ${g.expiresAt}.\n`);
    process.exit(0);
    break;
  }
  case 'revoke': {
    const name = values.name ?? fail('name the door with --name.');
    const { revokeDoor } = await import('@backbone-next/platform/composition/gateway');
    const options = await core();
    const n = await asPerson(() => revokeDoor({ home, name, ...options }));
    process.stdout.write(n ? `Revoked door "${name}" (${n} mandate(s)).\n` : `No mandate was revoked for "${name}". This result does not establish that no authority is standing.\n`);
    process.exit(0);
    break;
  }
  default:
    fail('use serve, host, grant or revoke.');
}
