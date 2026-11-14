// Run recovery records have one durable file per run. A stale aggregate projection cannot erase one.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, sha256, writeJson } from '../stub/fsx.ts';
import type { RunRecord } from './service.ts';

export function saveRun(home: string, record: RunRecord) {
  if (record.run) writeJson(join(home, 'triage', 'runs', `${sha256(record.run)}.json`), record);
}

export function loadRuns(home: string, local: RunRecord[], disk: RunRecord[], owned = new Set<RunRecord>()): RunRecord[] {
  const key = (r: RunRecord) => r.run || `${r.startedAt}:${r.trigger}`;
  const records = new Map([...disk, ...local].map((r) => [key(r), r]));
  const dir = join(home, 'triage', 'runs');
  if (existsSync(dir)) for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const record = readJson<RunRecord>(join(dir, file), {} as RunRecord);
    const current = records.get(key(record));
    records.set(key(record), current && owned.has(current) ? current : record);
  }
  return [...records.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
