// Project file enumeration and local-link resolution share the same project and material view.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, ProjectFile } from '../api.ts';
import { isIntermediate } from '../stub/fsx.ts';
import { trackedFiles } from '../stub/git.ts';
import type { MaterialStore } from '../stub/material.ts';

export function createProjectFiles({ findProject, projectDir, material }: {
  findProject: (id: string) => Project | undefined;
  projectDir: (id: string) => string;
  material: MaterialStore;
}) {
  /**
   * The project-relative path an absolute or local `file:` link names, or null. Both its written address
   * and its real path (links followed) must be inside the project's folder, so no link outside it, and
   * none inside it pointing out, names a document here.
   */
  function linkedPath(projectId: string, href: string): string | null {
    const raw = href.trim();
    // eslint-disable-next-line no-control-regex
    const unsafe = (s: string) => !s || /[\u0000-\u001f\\]/.test(s);
    if (unsafe(raw)) return null;
    let path: string;
    if (/^file:/i.test(raw)) {
      let url: URL;
      try { url = new URL(raw); } catch { return null; }
      if (url.host && url.host !== 'localhost') return null;
      try { path = fileURLToPath(new URL(url.pathname, 'file://')); } catch { return null; }
    } else if (raw.startsWith('/')) {
      try { path = decodeURIComponent(raw.replace(/[?#].*$/, '')); } catch { return null; }
    } else return null;
    if (unsafe(path)) return null;
    const within = (base: string, target: string) => {
      const rel = relative(base, target);
      return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
    };
    const root = projectDir(projectId);
    let realRoot: string;
    let real: string;
    try { realRoot = realpathSync(root); } catch { return null; }
    const written = resolve(path);
    if (within(root, written) === null && within(realRoot, written) === null) return null;
    try { real = realpathSync(written); } catch { return null; }
    return within(realRoot, real)?.split('\\').join('/') ?? null;
  }

  const facts = (entry: ReturnType<MaterialStore['list']>[number]) => ({ current: entry.current, by: entry.versions.find(v => v.n === entry.current)?.by, personSaved: entry.versions.findLast(v => v.by === 'person')?.n, ...(entry.projection === 'managed' ? { managed: true } : {}) });

  function filesOf(projectId: string): ProjectFile[] {
    const p = findProject(projectId);
    if (!p) return [];
    const root = projectDir(projectId);
    const byName = new Map(material.list(projectId).filter((entry) => entry.projection !== 'managed').map((e) => [e.name, e]));
    let paths: string[];
    if (p.kind === 'git') paths = trackedFiles(root);
    else {
      paths = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const name = entry.name;
          if (isIntermediate(name)) continue;
          // A project link is not a grant to enumerate another directory. This is a static
          // no-follow listing, not a confinement boundary against concurrent filesystem swaps.
          if (entry.isSymbolicLink()) continue;
          const full = join(dir, name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile()) paths.push(relative(root, full));
        }
      };
      if (existsSync(root)) walk(root);
    }
    const managed = material.list(projectId).filter((entry) => entry.projection === 'managed');
    const ordinary = paths
      // Unregistered paths remain visible, but are never presented as engine inputs.
      .filter((x) => !x.split('/').some(isIntermediate))
      .sort()
      .map((path) => {
        const e = byName.get(path);
        return e ? { path, class: e.class, materialId: e.id, ...facts(e) } : { path, class: 'unregistered' as const };
      });
    if (!managed.length) return ordinary;
    return [
      ...ordinary.map((file) => ({ ...file, group: 'files' as const })),
      ...managed.map((entry) => ({ path: entry.name, group: 'documents' as const, class: entry.class, materialId: entry.id, ...facts(entry) })),
    ];
  }

  return { linkedPath, filesOf };
}
