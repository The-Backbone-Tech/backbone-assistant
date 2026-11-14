import { MacSettings } from './MacFileAccess';
import { NoticesSection } from './settings/Notices';
import { ManagedPolicy } from './settings/ManagedPolicy';
// Settings, sectioned as the old Backbone app had it: a left column with search and two groups,
// You and Workspace; each row is a title, one line of explanation and its control on the right.
// A section joins the list when it works; nothing unbuilt is shown as a placeholder.
import { AgentRolesSection } from './settings/AgentRoles';
import { PeopleRoles } from './settings/PeopleRoles';
import { ProjectSharing } from './settings/ProjectSharing';
import { ArchiveRestore, ArrowLeft, Blocks, Cable, HeartPulse, type LucideIcon, Monitor, Moon, Plug, Route, Search, Settings2, Sun } from 'lucide-react';
import * as React from 'react';
import { brand } from '../brand';
import { compiledBuild } from '../lib/build';
import { useApp } from '../lib/state';
import { cn } from '../lib/utils';
import { AiToolsSection } from './settings/AiTools';
import { BackupSection } from './settings/Backup';
import { ConnectorsSection } from './settings/Connectors';
import { ModelRouteSection } from './settings/ModelRoute';
import { PluginsSection } from './settings/Plugins';
import { ProactiveSection } from './settings/Proactive';
import { SignedToolsSection } from './settings/SignedTools';
import { TelemetrySection } from './settings/Telemetry';
import { SettingsRow } from './settings/SettingsRow';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Input, Select } from './ui/input';

export type SectionId =
  'notices' | 'general' | 'ai-tools' | 'connectors' | 'signed-tools' | 'plugins' | 'agent-roles' | 'model-route' | 'proactive' | 'backup' | 'telemetry' | 'people' | 'sharing';

interface Part {
  id: SectionId;
  group: 'You' | 'Workspace';
  label: string;
  icon: LucideIcon;
  /** One line under the title. */
  about: string;
  /** Extra words the search also matches. */
  keywords?: string;
}

const PARTS: Part[] = [
  { id: 'notices', group: 'Workspace', label: 'Licences and notices', icon: Blocks, about: 'Every bundled piece and its attribution.', keywords: 'about license licence legal notice copyright third party' },
  {id:'people',group:'Workspace',label:'People and roles',icon:Settings2,about:'Invitations, roles and named automation identities.',keywords:'identity team company admin member guest invite'},
  {id:'sharing',group:'Workspace',label:'Sharing',icon:Settings2,about:'Give a colleague viewer or editor access to one project.',keywords:'project viewer editor access permissions'},
  { id: 'general', group: 'You', label: 'General', icon: Settings2, about: 'Appearance and language.', keywords: 'theme light dark system appearance language' },
  { id: 'ai-tools', group: 'You', label: 'Connect your AI tools', icon: Plug, about: `Claude Code, Codex, Cursor and Claude Desktop, acting through ${brand.name} with a receipt for each action.`, keywords: 'mcp door claude code codex cursor desktop connect permission receipts' },
  { id: 'connectors', group: 'You', label: 'Connected tools', icon: Cable, about: 'Your MCP servers, from your own configs, offered to every engine. Reads flow; changes wait for you.', keywords: 'mcp server connector gmail tools read held permission integrations' },
  { id: 'signed-tools', group: 'You', label: 'Tool permissions', icon: Cable, about: 'What you permitted to act without asking, and how to end it.', keywords: 'permission autonomy full balanced strict custom receipts' },
  { id: 'plugins', group: 'You', label: 'Plugin commands and agents', icon: Blocks, about: 'Commands, agents and hooks of the Claude Code plugins you enabled. Each is off until you enable it; hooks are never run.', keywords: 'plugin command slash agent subagent hook claude code' },
  { id: 'agent-roles', group: 'You', label: 'Agent roles', icon: Blocks, about: 'Reusable instructions, model and tools for your helpers.', keywords: 'custom agent role subagent helper markdown' },
  { id: 'proactive', group: 'Workspace', label: 'Heartbeat and brief', icon: HeartPulse, about: 'A standing check inside active hours, and when the daily brief comes.', keywords: 'schedule heartbeat brief proactive routine cron daily morning' },
  { id: 'telemetry', group: 'Workspace', label: 'Telemetry', icon: Route, about: 'Content-free spans in your own collector.', keywords: 'otel otlp observability tracing collector headers' },
  { id: 'backup', group: 'Workspace', label: 'Backup', icon: ArchiveRestore, about: 'The whole data folder in plain files, without any key or credential, and a check of an export.', keywords: 'backup export restore copy move computer data files archive' },
  { id: 'model-route', group: 'You', label: 'AI and models', icon: Route, about: 'How chats connect to a model, and who bills the connection.', keywords: 'key api gateway openrouter vercel anthropic openai model engine route local ollama lm studio llama.cpp vllm' },
];

export function SettingsDialog({ open, onOpenChange, section, onReturnFocus }: { open: boolean; onOpenChange: (o: boolean) => void; section?: SectionId; onReturnFocus?: () => void }) {
  const [current, setCurrent] = React.useState<SectionId>('general');
  const [query, setQuery] = React.useState('');
  // On a phone the list and the section take turns.
  const [detail, setDetail] = React.useState(false);
  // Opened at a section (Needs you sends a held call's person straight to Connected tools).
  React.useEffect(() => { if (open && section) { setCurrent(section); setDetail(true); } }, [open, section]);
  const q = query.trim().toLowerCase();
  const found = PARTS.filter((p) => !q || `${p.label} ${p.about} ${p.keywords ?? ''}`.toLowerCase().includes(q));
  const part = PARTS.find((p) => p.id === current) ?? PARTS[0];

  return (
    <Dialog open={open} onOpenChange={(o) => (onOpenChange(o), o || setDetail(false))}>
      <DialogContent title="Settings" bare onCloseAutoFocus={(e) => { if (onReturnFocus) { e.preventDefault(); onReturnFocus(); } }} className="flex h-[min(720px,calc(100dvh-2rem))] max-w-4xl overflow-hidden">
        <div className={cn('flex w-full flex-col border-r border-border bg-sidebar sm:w-60 sm:shrink-0', detail && 'hidden sm:flex')}>
          <div className="p-4">
            <p className="mb-3 px-1 text-sm font-semibold" aria-hidden>
              Settings
            </p>
            <label className="relative flex items-center">
              <Input type="search" aria-label="Search settings" placeholder="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 pl-8" />
              <Search className="pointer-events-none absolute left-2.5 size-4 text-muted" aria-hidden />
            </label>
          </div>
          <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {(['You', 'Workspace'] as const).map((group) => {
              const parts = found.filter((p) => p.group === group);
              if (!parts.length) return null;
              return (
                <div key={group} className="mb-3">
                  <p className="px-2 py-1 text-xs font-medium text-muted">{group}</p>
                  <ul>
                    {parts.map((p) => (
                      <li key={p.id}>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-current={p.id === current ? 'page' : undefined}
                          className={cn('h-8 w-full justify-start gap-2 px-2 text-left text-ui', p.id === current ? 'bg-hover font-medium' : 'text-muted')}
                          onClick={() => (setCurrent(p.id), setDetail(true))}
                        >
                          <p.icon className="size-4 shrink-0 text-muted" aria-hidden />
                          <span className="truncate">{p.label}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {found.length === 0 && <p className="px-2 py-1 text-xs text-muted">No setting matches “{query}”.</p>}
          </nav>
        </div>
        <section data-workspace aria-labelledby="settings-section-title" className={cn('min-w-0 flex-1 flex-col bg-bg text-fg', detail ? 'flex' : 'hidden sm:flex')}>
          <header className="flex items-center gap-2 border-b border-border px-4 py-4 sm:px-7">
            <Button variant="ghost" size="icon-sm" className="sm:hidden" aria-label="All settings" onClick={() => setDetail(false)}>
              <ArrowLeft />
            </Button>
            <div className="min-w-0">
              <h2 id="settings-section-title" className="text-base font-semibold">
                {part.label}
              </h2>
              <p className="text-xs text-muted">{part.about}</p>
            </div>
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-7">
            <ManagedPolicy />
            {part.id === 'notices' ? <NoticesSection /> : part.id === 'people' ? <PeopleRoles /> : part.id === 'sharing' ? <ProjectSharing /> : part.id === 'general' ? <General /> : part.id === 'ai-tools' ? <AiToolsSection /> : part.id === 'connectors' ? <ConnectorsSection /> : part.id === 'signed-tools' ? <SignedToolsSection /> : part.id === 'plugins' ? <PluginsSection /> : part.id === 'agent-roles' ? <AgentRolesSection /> : part.id === 'proactive' ? <ProactiveSection /> : part.id === 'backup' ? <BackupSection /> : part.id === 'telemetry' ? <TelemetrySection /> : <ModelRouteSection />}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function General() {
  const { prefs, setPrefs } = useApp();
  return (
    <div>
      <SettingsRow title="Appearance" about="Light, Dark, or follow this computer.">
        <div role="radiogroup" aria-label="Appearance" className="inline-flex rounded-lg border border-border bg-sunken p-1">
          {(
            [
              ['system', Monitor, 'System'],
              ['light', Sun, 'Light'],
              ['dark', Moon, 'Dark'],
            ] as const
          ).map(([id, Icon, label]) => (
            <Button
              key={id}
              role="radio"
              aria-checked={prefs.theme === id}
              variant="ghost"
              size="sm"
              className={cn('h-8 gap-1.5 rounded-md px-3', prefs.theme === id ? 'bg-surface text-fg shadow-sm' : 'text-muted')}
              onClick={() => setPrefs((p) => ({ ...p, theme: id }))}
            >
              <Icon className="size-3.5" aria-hidden /> {label}
            </Button>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow title="Language" about="The language of the app.">
        <Select aria-label="Language">
          <option>English</option>
        </Select>
      </SettingsRow>
      <MacSettings />
      <BuildDetails />
      <p className="pt-4 text-xs text-muted">{brand.name} · Apache-2.0 · fonts IBM Plex Sans and JetBrains Mono (OFL-1.1)</p>
    </div>
  );
}



function BuildDetails() {
  const [runtime, setRuntime] = React.useState<{ packaged: boolean; version: string } | null | 'unknown'>();
  React.useEffect(() => {
    let live = true;
    void (window.backbone?.appInfo?.() ?? Promise.resolve(null)).then((value) => { if (live) setRuntime(value); }, () => { if (live) setRuntime('unknown'); });
    return () => { live = false; };
  }, []);
  return <SettingsRow title="Build" about="The app running here and the source compiled into it.">
    <div className="max-w-sm break-words text-sm sm:text-right" data-testid="build-identity">
      <p>{runtime === undefined ? 'Checking runtime…' : runtime === 'unknown' ? 'Runtime unknown' : runtime ? runtime.packaged ? 'Packaged desktop app' : 'Unpacked desktop build' : 'Browser preview'}</p>
      {compiledBuild ? <>
        <p>Build version {compiledBuild.version} · {compiledBuild.revision ? <span title={compiledBuild.revision}>Revision {compiledBuild.revision.slice(0, 12)}</span> : 'Revision unknown (Git unavailable)'}</p>
        <p>{compiledBuild.dirty === null ? 'Working tree unknown' : compiledBuild.dirty ? 'Includes uncommitted changes' : 'Clean source checkout'}</p>
        <p className="text-xs text-muted">Build {compiledBuild.id} · {compiledBuild.builtAt}</p>
      </> : <p className="text-muted">Development preview · no compiled revision</p>}
    </div>
  </SettingsRow>;
}
