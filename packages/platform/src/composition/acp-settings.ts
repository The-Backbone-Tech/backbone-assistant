import { join } from 'node:path';
import type { AcpAgentConfiguration } from '../api.ts';
import { readJson, writeJson } from '../stub/fsx.ts';
import { acpConfiguration } from './harnesses.ts';
import { assertHomeWriteAdmission } from './home-lock.ts';
import { verifyAcpAcceptance } from './acp-executable.ts';

/** Called within ModelRoutes' home lock. Saving never changes a running engine or starts a process. */
export function saveAcpSettingsHeld(home: string, configuration: AcpAgentConfiguration): void {
  const allowed = ['acceptsProcessVisibility', 'acceptsPersonRights', 'acceptance', 'agent', 'command', 'args', 'environment', 'environmentVariables', 'machineClient'];
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || Object.keys(configuration).some(key => !allowed.includes(key))) {
    throw new Error('Use ACP configuration fields only; environment values and credentials cannot be saved here.');
  }
  verifyAcpAcceptance(configuration);
  const checked = acpConfiguration(home, configuration, {});
  if (checked.blocked) throw new Error(checked.blocked);
  const path = join(home, 'settings.json');
  const stored = readJson<{ harnesses?: Record<string, unknown> } & Record<string, unknown>>(path, {});
  assertHomeWriteAdmission(home);
  writeJson(path, { ...stored, harness: 'harness-acp', harnesses: { ...stored.harnesses, 'harness-acp': configuration } });
}
