// Explicit fixture consent for an owned local executable; never signs in or starts a process.
import type { AcpAgentConfiguration, AcpAgentDraft } from '../api-acp.ts';
import { prepareAcpConfiguration } from '../composition/acp-executable.ts';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Executable fixtures need trusted ancestors: Linux /tmp is deliberately refused in production. */
export function freshAcpExecutableDirectory(prefix: string, context?: { after(fn: () => void): unknown }): string {
  const parent = join(process.cwd(), 'evidence');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = realpathSync(mkdtempSync(join(parent, prefix)));
  context?.after(() => rmSync(path, { recursive: true, force: true }));
  return path; // Callers without a test context remove this owned directory in their finally block.
}
export function acceptAcpTestConfiguration(home: string, configuration: AcpAgentDraft & { acceptsProcessVisibility?: unknown }, env: NodeJS.ProcessEnv = process.env): AcpAgentConfiguration {
  if (configuration.acceptsProcessVisibility !== true) throw new Error('A fixture must explicitly accept ACP process visibility.');
  const p = prepareAcpConfiguration(home, configuration, env);
  return { ...p.configuration, acceptsProcessVisibility: true, ...(p.configuration.environment === 'person-rights' ? { acceptsPersonRights: true } : {}), acceptance: p.acceptance };
}
