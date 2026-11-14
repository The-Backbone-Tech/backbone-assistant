import { existsSync } from 'node:fs';
import { putTelemetryEndpoint, putTelemetryHeaders } from '@backbone-next/platform/credentials/telemetry';
import { chooseKeys } from '@backbone-next/platform/system-keys';
import { EXIT, type Io, type Parsed } from './commands.ts';
import { refuseClosedApp } from './session.ts';

export async function telemetryCommand(parsed: Parsed, io: Pick<Io, 'out' | 'err'>, input: AsyncIterable<string | Buffer>): Promise<number> {
  if (!existsSync(parsed.home)) throw new Error('Create this data folder before configuring telemetry.');
  if (parsed.name === 'telemetry header') {
    refuseClosedApp(parsed.home);
    let body = '';
    for await (const chunk of input) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 32768) throw new Error('Collector header input is too long.');
    }
    let headers: unknown;
    try { headers = JSON.parse(body); }
    catch { throw new Error('Pipe a JSON object of collector headers on standard input.'); }
    await putTelemetryHeaders(parsed.home, headers, await chooseKeys(parsed.home, process.env, undefined, { create: false }));
    io.out('Collector headers stored sealed. Restart the app or daemon to apply them.');
  } else {
    await putTelemetryEndpoint(parsed.home, parsed.name === 'telemetry off' ? undefined : parsed.target);
    io.out(parsed.name === 'telemetry off' ? 'Telemetry disabled and stored collector headers removed. Restart the app or daemon to apply it.' : 'Collector endpoint stored. Restart the app or daemon to enable content-free telemetry.');
  }
  return EXIT.OK;
}
