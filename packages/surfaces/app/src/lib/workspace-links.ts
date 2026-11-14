// Local file links in an answer. A relative link opens a document of this project's workspace in
// the side pane; an absolute or local file: link opens only what the platform resolved for that
// project (files.resolveLink: it knows the folder, the app never does). Anything else is shown as
// text and followed nowhere. Web, mail and in-page links are left to
// Streamdown's own hardening and link-safety prompt. Only a document the workspace lists can open,
// by its id: no path here reaches the file system.
import type { FileLink, ProjectFile } from '@backbone-next/platform';

export type LinkTarget =
  | { kind: 'external' }
  | { kind: 'workspace'; materialId: string; version?: number; path: string }
  | { kind: 'blocked' };

const BLOCKED: LinkTarget = { kind: 'blocked' };
const EXTERNAL: LinkTarget = { kind: 'external' };

/** Segments of a local path with `.` and `..` applied, or null when it climbs above its start. */
function segments(path: string): string[] | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(part);
  }
  return out;
}

/** What an answer's links may open: its own project, that project's listed documents, and the versions its turn recorded. */
export interface LinkContext {
  projectId: string;
  /** The workspace list as last read, with the project it was read for: a list still from another project opens nothing. */
  workspace?: { projectId: string; files: ProjectFile[] };
  touched: FileLink[];
  /** Absolute addresses the platform resolved (files.resolveLink) for that project: it knows the folder, the app does not. */
  resolved?: { projectId: string; links: Record<string, { materialId: string; path: string }> };
}

/** Changes whenever what a link could open changes; equal for a refetch of the same list. */
export function linkKey({ projectId, workspace, touched, resolved }: LinkContext): string {
  const files = workspace ? workspace.files.flatMap((f) => (f.materialId ? [`${f.path}\u0000${f.materialId}`] : [])).join('\u0001') : '';
  const links = resolved ? Object.entries(resolved.links).map(([href, l]) => `${href}\u0000${l.materialId}`).sort().join('\u0001') : '';
  return JSON.stringify([projectId, workspace?.projectId ?? null, files, touched.map((f) => `${f.materialId}:${f.version}`), resolved?.projectId ?? null, links]);
}

/** An address only the platform can resolve: an absolute path (a local file: link arrives as one). */
export const askPlatform = (href: string) => href.trim().startsWith('/') && !href.trim().startsWith('//');

export function resolveLink(href: string, { projectId, workspace, touched, resolved }: LinkContext): LinkTarget {
  const raw = href.trim();
  const versionOf = (materialId: string) => touched.find((f) => f.materialId === materialId)?.version;
  if (askPlatform(raw)) {
    const link = resolved?.projectId === projectId ? resolved.links[raw] : undefined;
    // Only while the current list of this project still has that document: a withdrawal or removal since the platform answered closes it.
    if (!link || workspace?.projectId !== projectId || !workspace.files.some((f) => f.materialId === link.materialId)) return BLOCKED;
    const version = versionOf(link.materialId);
    return { kind: 'workspace', materialId: link.materialId, ...(version === undefined ? {} : { version }), path: link.path };
  }
  if (!raw) return BLOCKED;
  if (raw.startsWith('#') || raw.startsWith('//')) return EXTERNAL;
  // A file: address left here (a local one became its path before sanitizing), a drive or a backslash path never opens.
  if (/^file:/i.test(raw) || /^[a-z]:[\\/]/i.test(raw) || raw.includes('\\')) return BLOCKED;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return EXTERNAL;
  let path = raw.replace(/[?#].*$/, '');
  try { path = decodeURIComponent(path); } catch { return BLOCKED; }
  // A home path is refused outright; an absolute one was handled above, by what the platform resolved.
  // eslint-disable-next-line no-control-regex
  if (path.startsWith('/') || path.startsWith('~') || /[\u0000-\u001f\\]/.test(path)) return BLOCKED;
  const parts = segments(path);
  if (!parts?.length) return BLOCKED;
  if (!workspace || workspace.projectId !== projectId) return BLOCKED;
  const relative = parts.join('/');
  const file = workspace.files.find((f) => f.materialId && f.path === relative);
  if (!file) return BLOCKED;
  const version = versionOf(file.materialId!);
  return { kind: 'workspace', materialId: file.materialId!, ...(version === undefined ? {} : { version }), path: relative };
}

interface HastNode { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }

/** A rehype step before sanitizing, which drops `file:` addresses: a local `file:` link keeps its path, for the platform to resolve. */
export function fileUrlsAsPaths() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => node.children?.forEach((child) => {
      const href = child.properties?.href;
      if (child.tagName === 'a' && typeof href === 'string' && /^\s*file:/i.test(href)) {
        let url: URL | undefined;
        try { url = new URL(href.trim()); } catch { /* no address */ }
        if (url && (!url.host || url.host === 'localhost') && url.pathname.startsWith('/')) child.properties!.href = url.pathname;
        else delete child.properties!.href;
      }
      walk(child);
    });
    walk(tree);
  };
}

/**
 * A rehype step, placed after sanitizing and before hardening: workspace links become openers, other
 * local links plain text. Use it as `[workspaceLinks, { key, resolve }]`: Streamdown caches a processor
 * by its plugins' names and JSON options, so `key` must differ wherever `resolve` does.
 * With `defer`, local addresses become inert component data for current-context React resolution.
 */
export function workspaceLinks({ resolve, found, defer = false }: { key: string; answer?: string; defer?: boolean; resolve: (href: string) => LinkTarget; found?: (href: string) => void }) {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      node.children?.forEach((child, i) => {
        if (child.type === 'element' && child.tagName === 'a') {
          // An anchor whose address sanitizing removed is never followable.
          const href = child.properties?.href;
          if (typeof href === 'string' && askPlatform(href)) found?.(href.trim());
          const target = typeof href === 'string' ? resolve(href) : BLOCKED;
          if (defer && typeof href === 'string' && target.kind !== 'external') {
            // Keep an inert address for the React link component to resolve against current context.
            // Never emit href: this cannot become a browser or filesystem navigation.
            node.children![i] = { type: 'element', tagName: 'workspace-link', properties: { dataHref: href }, children: child.children ?? [] };
          } else if (target.kind === 'workspace') {
            node.children![i] = { type: 'element', tagName: 'workspace-link', properties: { dataMaterial: target.materialId, dataVersion: target.version === undefined ? '' : String(target.version), dataPath: target.path }, children: child.children ?? [] };
          } else if (target.kind === 'blocked') {
            node.children![i] = { type: 'element', tagName: 'blocked-link', properties: {}, children: child.children ?? [] };
          }
        }
        walk(node.children![i]);
      });
    };
    walk(tree);
  };
}
