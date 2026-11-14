/** Installed external ACP agent. Values of environment variables never belong in this object. */
export interface AcpAgentConfiguration {
  acceptsProcessVisibility: true;
  acceptsPersonRights?: true;
  acceptance?: AcpExecutableAcceptance;
  agent: string;
  command: string;
  args?: string[];
  environment?: 'restricted-writes' | 'person-rights';
  environmentVariables?: string[];
  /** Use the installed Claude CLI's machine sign-in, with explicit person-rights. No Host credential. */
  machineClient?: 'claude';
}
export interface AcpExecutableIdentity { path: string; sha256: string; dev: number; ino: number }
export interface AcpExecutableAcceptance { executable: AcpExecutableIdentity; machineExecutable?: AcpExecutableIdentity; configurationSha256: string }
export type AcpAgentDraft = Omit<AcpAgentConfiguration, 'acceptsProcessVisibility' | 'acceptsPersonRights' | 'acceptance'>;
export interface AcpPrepared { configuration: AcpAgentDraft; acceptance: AcpExecutableAcceptance }
export interface AcpModelSettings { machineClient?: 'claude'; machineClientState?: MachineClientState; acpPrepared?: AcpPrepared }
export interface MachineClientState {
  client: 'claude';
  state: 'checking' | 'signed-in' | 'signed-out' | 'different-auth' | 'absent' | 'error';
  source: 'claude auth status --json';
}
export type AcpSettingsChange = { route: 'agent'; configuration: AcpAgentConfiguration } | { route: 'agent-resolve'; configuration: AcpAgentDraft } | { route: 'agent-refresh' };
/** The maintained successor to Zed's claude-code-acp; installed separately by the person. */
export const ACP_CLAUDE_PRESET = { agent: 'claude', command: 'claude-agent-acp', args: [], version: '0.105.0', package: '@agentclientprotocol/claude-agent-acp', license: 'Apache-2.0' } as const;
export const ACP_PROCESS_VISIBILITY_WARNING = "An ACP agent runs as you. With restricted-writes, it can read whatever you can read except the listed credential places, this Host's data folder, denied folders and ACP storage outside its own folders. It can read environment variables and command lines of your other running programs, which often hold API keys. It has unrestricted outbound IP network, including loopback. The restricted-writes setting only stops it writing outside its own folders, signalling other processes and starting system background services. With person-rights, a custom agent can read and write this app's data folder, including settings.json, and reach machine credentials; OS restrictions are off.";
