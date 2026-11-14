// Desktop-only settings use the app's existing HomeKeys; secret values are never read back to UI.
import { collectorEndpoint, collectorHeaders, putTelemetryEndpoint, putTelemetryHeaders, readTelemetrySettings } from '@backbone-next/platform/credentials/telemetry';
import type { HomeKeys } from '@backbone-next/platform/keys';

export function telemetryView(home: string): { endpoint: string } {
  return { endpoint: readTelemetrySettings(home)?.endpoint ?? '' };
}

export async function configureTelemetry(home: string, keys: HomeKeys, request: unknown): Promise<{ ok: boolean }> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Telemetry settings are not valid.');
  const given = request as { endpoint?: unknown; headers?: unknown };
  if (typeof given.endpoint !== 'string' || (given.headers !== undefined && typeof given.headers !== 'string') || Object.keys(given).some(key => !['endpoint', 'headers'].includes(key))) throw new Error('Telemetry settings are not valid.');
  const endpoint = given.endpoint ? collectorEndpoint(given.endpoint) : undefined;
  let headers: Record<string, string> | undefined;
  if (endpoint && typeof given.headers === 'string' && given.headers.trim()) {
    if (Buffer.byteLength(given.headers) > 32768) throw new Error('Collector header input is too long.');
    try { headers = collectorHeaders(JSON.parse(given.headers)); }
    catch { throw new Error('Use a JSON object of collector header names and string values.'); }
  }
  if (headers !== undefined) await putTelemetryHeaders(home, headers, keys);
  await putTelemetryEndpoint(home, endpoint);
  return { ok: true };
}
