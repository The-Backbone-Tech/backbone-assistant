// Assistants using this app: Claude Code, Codex, Cursor and Claude Desktop act through the MCP door,
// under a permission the person gives. Connect asks the app's main process, which shows the actual
// grant in its own window: one click there approves it, "Change…" narrows it. This page never
// grants; it lists, starts that confirmation, and disconnects (which only takes authority back).
import type { AiTool } from '@backbone-next/platform';
import * as React from 'react';
import { brand } from '../../brand';
import { call, connectTool } from '../../lib/api';
import { permissionWords } from '../../lib/permission';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { SettingsRow } from './SettingsRow';
import { useSettingsRead } from '../../lib/use-settings-read';
import { SettingsReadStatus } from './SettingsReadStatus';

const readTools = () => call('tools.list', {});

const STATE: Record<AiTool['state'], { label: string; tone: 'neutral' | 'committed' | 'pending' | 'danger' }> = {
  'not-installed': { label: 'Not installed', tone: 'neutral' },
  disconnected: { label: 'Not connected', tone: 'neutral' },
  connected: { label: 'Connected', tone: 'committed' },
  'needs-restart': { label: 'Needs restart', tone: 'pending' },
  'needs-attention': { label: 'Needs attention', tone: 'danger' },
};

export function AiToolsSection() {
  const { value: data, pending, failed, reload: load } = useSettingsRead(readTools, 'tools');
  const status = <SettingsReadStatus label="Assistants using this app" pending={pending} failed={failed} hasValue={data !== undefined} retry={load} />;
  if (!data) return status;
  if (!data.available) return <>{status}<p className="py-4 text-sm text-muted">Connecting AI tools is done in the desktop app.</p></>;
  return (
    <div>
      {status}
      <fieldset aria-label="Assistants using this app">
      <p className="pt-3 text-xs text-muted">
        Each tool acts through {brand.name}: every action is checked against the permission you give it and gets a receipt. Disconnect takes the permission back at once.
      </p>
      {data.tools.map((t) => (
        <ToolRow key={t.id} tool={t} onChange={load} />
      ))}
      </fieldset>
    </div>
  );
}

function ToolRow({ tool, onChange }: { tool: AiTool; onChange: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const state = STATE[tool.state];
  const connected = tool.permission !== null;
  const about = connected ? (
    <>
      May {permissionWords(tool.permission!, brand.name)} · {tool.receipts} {tool.receipts === 1 ? 'receipt' : 'receipts'}
      {tool.note && <span className="block">{tool.note}</span>}
    </>
  ) : tool.state === 'not-installed' ? (
    'Not on this computer.'
  ) : (
    tool.note ?? undefined
  );

  async function act(run: () => Promise<{ ok: boolean; detail?: string }>) {
    setBusy(true);
    setError(undefined);
    const r = await run();
    setBusy(false);
    if (!r.ok && r.detail && !r.detail.endsWith('you cancelled.')) setError(r.detail);
    onChange();
  }

  return (
    <div data-testid={`tool-${tool.id}`}>
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-2">
            {tool.name} <Badge tone={state.tone}>{state.label}</Badge>
          </span>
        }
        about={about}
      >
        {tool.update && (
          <Button size="sm" disabled={busy} onClick={() => void act(() => connectTool(tool.id))}>
            Approve again
          </Button>
        )}
        {connected ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(() => call('tools.disconnect', { tool: tool.id }))}>
            Disconnect
          </Button>
        ) : tool.state !== 'not-installed' ? (
          <Button size="sm" disabled={busy} onClick={() => void act(() => connectTool(tool.id))}>
            Connect
          </Button>
        ) : null}
      </SettingsRow>
      {error && <p className="pb-3 text-xs text-danger">{error}</p>}
    </div>
  );
}
