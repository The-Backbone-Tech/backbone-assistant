import { MacSettings } from './MacFileAccess';
import { NoticesSection } from './settings/Notices';
import { ManagedPolicy } from './settings/ManagedPolicy';
// Settings: a left column with search and groups named by the decision a person makes there (You, AI,
// Apps and tools, Team, This computer); each row is a title, one line of explanation and its control on
// the right. A section joins the list when it works; nothing unbuilt is shown as a placeholder.
// Renamed sections keep their old names as search words, so a guide or habit that uses them still finds them.
import { AgentRolesSection } from './settings/AgentRoles';
import { PeopleRoles } from './settings/PeopleRoles';
import { ProjectSharing } from './settings/ProjectSharing';
import { ArchiveRestore, ArrowLeft, Blocks, Cable, HeartPulse, type LucideIcon, Monitor, Moon, Plug, Route, Search, Settings2, Sun } from 'lucide-react';
import * as React from 'react';
import { brand } from '../brand';
import { compiledBuild } from '../lib/build';
import type { SettingsSectionId } from '@backbone-next/platform';
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
import { SettingsLink } from './settings/settings-link';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Input } from './ui/input';
import { RadioGroup } from 'radix-ui';
import { buttonVariants } from './ui/button';

/** One set of section ids, shared with the stored last-used section (the platform drops any other value). */
export type SectionId = SettingsSectionId;

const GROUPS = ['You', 'AI', 'Apps and tools', 'Team', 'This computer'] as const;

interface Part {
  id: SectionId;
  group: (typeof GROUPS)[number];
  label: string;
  icon: LucideIcon;
  /** One line under the title: what the person decides there. */
  about: string;
  /** Extra words the search also matches, including a section's former name. */
  keywords?: string;
}

// In the order a person meets them. Product messages and guides point to "People and roles", "AI and
// models", "Backup", "Connected tools", "Tool permissions" and "Sharing": those names stay.
const PARTS: Part[] = [
  { id: 'general', group: 'You', label: 'General', icon: Settings2, about: 'How the app looks, its language and the build running here.', keywords: 'theme light dark system appearance language version revision build' },
  { id: 'model-route', group: 'AI', label: 'AI and models', icon: Route, about: 'The engine your chats run on, the model it uses, and who bills it.', keywords: 'key api gateway openrouter vercel anthropic openai model engine codex pi acp agent route local ollama lm studio llama.cpp vllm shared work colleagues' },
  { id: 'agent-roles', group: 'AI', label: 'Helper roles', icon: Blocks, about: 'Saved instructions, model and tools for the helpers a chat starts. Colleagues are in People and roles.', keywords: 'agent roles custom agent role subagent helper markdown' },
  { id: 'connectors', group: 'Apps and tools', label: 'Connected tools', icon: Cable, about: `Apps this assistant can use, such as mail or notes, and what each may change.`, keywords: 'mcp server connector gmail tools read held permission integrations' },
  { id: 'signed-tools', group: 'Apps and tools', label: 'Tool permissions', icon: Cable, about: 'What may act without asking you first, and how to end it.', keywords: 'permission autonomy full balanced strict custom receipts' },
  { id: 'plugins', group: 'Apps and tools', label: 'Plugins', icon: Blocks, about: 'Commands and agents from the Claude Code plugins you enabled. Each is off until you turn it on; hooks never run.', keywords: 'plugin commands and agents command slash agent subagent hook claude code' },
  { id: 'ai-tools', group: 'Apps and tools', label: 'Assistants using this app', icon: Plug, about: `Other assistants that may act through this one: Claude Code, Codex, Cursor and Claude Desktop, with a receipt for each action in ${brand.name}.`, keywords: 'connect your ai tools mcp door claude code codex cursor desktop connect permission receipts' },
  { id: 'people', group: 'Team', label: 'People and roles', icon: Settings2, about: 'Who is in this workspace, what each may do, invitations and automation identities.', keywords: 'identity team company admin member guest invite colleague' },
  { id: 'sharing', group: 'Team', label: 'Sharing', icon: Settings2, about: 'Give a colleague viewer or editor access to one project.', keywords: 'project viewer editor access permissions' },
  { id: 'proactive', group: 'This computer', label: 'Heartbeat and brief', icon: HeartPulse, about: 'A standing check inside active hours, and when the daily brief comes.', keywords: 'schedule heartbeat brief proactive routine cron daily morning' },
  { id: 'backup', group: 'This computer', label: 'Backup', icon: ArchiveRestore, about: 'Export the whole data folder as plain files, without any key or credential, and check an export.', keywords: 'backup export restore copy move computer data files archive' },
  { id: 'telemetry', group: 'This computer', label: 'Telemetry', icon: Route, about: 'Send content-free traces to a collector of your own, or nowhere.', keywords: 'otel otlp observability tracing collector headers' },
  { id: 'notices', group: 'This computer', label: 'Licences and notices', icon: Blocks, about: 'Every bundled piece and its attribution.', keywords: 'about license licence legal notice copyright third party' },
];

export function SettingsDialog({ open, onOpenChange, section, onReturnFocus }: { open: boolean; onOpenChange: (o: boolean) => void; section?: SectionId; onReturnFocus?: () => void }) {
  const [current, setCurrent] = React.useState<SectionId>('general');
  const [query, setQuery] = React.useState('');
  // On a narrow window the list and the section take turns.
  const [detail, setDetail] = React.useState(false);
  const back = React.useRef<HTMLButtonElement>(null);
  const list = React.useRef<HTMLElement>(null);
  // Where focus goes once the list or the section is shown: keyboard users keep their place.
  const focusNext = React.useRef<'back' | 'list' | null>(null);
  const { prefs, setPrefs } = useApp();
  // Opened at a section (Needs you sends a held call's person straight to Connected tools); otherwise
  // at the section this viewer used last, which their viewer settings keep across reopening the app.
  React.useEffect(() => {
    if (open && section) { setCurrent(section); setDetail(true); }
    else if (open && PARTS.some((p) => p.id === prefs.settingsSection)) setCurrent(prefs.settingsSection!);
    // Read once as Settings opens; a later change of the stored value must not move an open dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, section]);
  React.useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'back' && back.current?.offsetParent) back.current.focus();
    if (target === 'list') list.current?.querySelector<HTMLButtonElement>('[aria-current=page]')?.focus();
  }, [detail]);
  const q = query.trim().toLowerCase();
  const found = PARTS.filter((p) => !q || `${p.label} ${p.about} ${p.keywords ?? ''}`.toLowerCase().includes(q));
  const part = PARTS.find((p) => p.id === current) ?? PARTS[0];
  const choose = (id: SectionId) => { setCurrent(id); focusNext.current = 'back'; setDetail(true); if (prefs.settingsSection !== id) setPrefs((p) => ({ ...p, settingsSection: id })); };
  // A link from inside a section (a refusal naming a setting) opens that section, then puts the keyboard on
  // the named control once the section has loaded it; if it never appears, the keyboard stays where it was.
  const link = (id: SectionId, focus?: string) => {
    choose(id);
    if (!focus) return;
    const until = Date.now() + 5_000;
    const reach = () => {
      const target = document.querySelector<HTMLElement>(focus);
      if (target) { target.scrollIntoView({ block: 'nearest' }); target.focus(); }
      else if (Date.now() < until) requestAnimationFrame(reach);
    };
    requestAnimationFrame(reach);
  };

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
          <nav ref={list} aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {GROUPS.map((group) => {
              const parts = found.filter((p) => p.group === group);
              if (!parts.length) return null;
              const id = `settings-group-${group.replace(/\W+/g, '-').toLowerCase()}`;
              return (
                <div key={group} className="mb-3">
                  <h3 id={id} className="px-2 py-1 text-xs font-medium text-muted">{group}</h3>
                  <ul role="group" aria-labelledby={id}>
                    {parts.map((p) => (
                      <li key={p.id}>
                        <Button
                          variant="ghost"
                          size="sm"
                          title={p.about}
                          aria-current={p.id === current ? 'page' : undefined}
                          className={cn('h-8 w-full justify-start gap-2 px-2 text-left text-ui', p.id === current ? 'bg-hover font-medium' : 'text-muted')}
                          onClick={() => choose(p.id)}
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
            <Button ref={back} variant="ghost" size="icon-sm" className="sm:hidden" aria-label="All settings" title="All settings" onClick={() => { focusNext.current = 'list'; setDetail(false); }}>
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
            <SettingsLink.Provider value={link}>
            <ManagedPolicy />
            {part.id === 'notices' ? <NoticesSection /> : part.id === 'people' ? <PeopleRoles /> : part.id === 'sharing' ? <ProjectSharing /> : part.id === 'general' ? <General /> : part.id === 'ai-tools' ? <AiToolsSection /> : part.id === 'connectors' ? <ConnectorsSection /> : part.id === 'signed-tools' ? <SignedToolsSection /> : part.id === 'plugins' ? <PluginsSection /> : part.id === 'agent-roles' ? <AgentRolesSection /> : part.id === 'proactive' ? <ProactiveSection /> : part.id === 'backup' ? <BackupSection /> : part.id === 'telemetry' ? <TelemetrySection /> : <ModelRouteSection />}
            </SettingsLink.Provider>
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
        <RadioGroup.Root aria-label="Appearance" orientation="horizontal" value={prefs.theme} onValueChange={(theme) => setPrefs((p) => ({ ...p, theme: theme as typeof p.theme }))} className="inline-flex rounded-lg border border-border bg-sunken p-1">
          {(
            [
              ['system', Monitor, 'System'],
              ['light', Sun, 'Light'],
              ['dark', Moon, 'Dark'],
            ] as const
          ).map(([id, Icon, label]) => (
            // Radix's radio group gives the segmented control one tab stop and arrow keys; the look is unchanged.
            <RadioGroup.Item key={id} value={id} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-8 gap-1.5 rounded-md px-3', prefs.theme === id ? 'bg-surface text-fg shadow-sm' : 'text-muted')}>
              <Icon className="size-3.5" aria-hidden /> {label}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </SettingsRow>
      <SettingsRow title="Language" about="The app is available in English.">
        <span className="text-sm text-muted">English</span>
      </SettingsRow>
      <MacSettings />
      <BuildDetails />
    </div>
  );
}



function BuildDetails() {
  const [runtime, setRuntime] = React.useState<{ packaged: boolean; version: string; dataFolder?: string } | null | 'unknown'>();
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
      </> : <p className="text-muted">Development preview · no compiled revision</p>}
      {runtime && runtime !== 'unknown' && runtime.dataFolder && <p data-testid="current-data-folder" className="mt-2 break-all font-mono text-xs">Data folder: {runtime.dataFolder}</p>}
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer">Build details</summary>
        <div className="mt-2 space-y-2">
          {compiledBuild && <p>Build {compiledBuild.id} · {compiledBuild.builtAt}</p>}
          <p>{brand.name} · Apache-2.0 · fonts IBM Plex Sans and JetBrains Mono (OFL-1.1)</p>
        </div>
      </details>
    </div>
  </SettingsRow>;
}
