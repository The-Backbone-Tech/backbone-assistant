// The rehype plugins of one answer: Streamdown's own (raw HTML, sanitizing, hardening) with this
// app's link steps between them. Streamdown caches a processor by its plugins' names and JSON
// options, and drops callbacks from that key, so `answer` must be unique per answer: otherwise a
// second answer in the same context runs the first one's `resolve` and `found`.
import { defaultRehypePlugins, type StreamdownProps } from 'streamdown';
import { fileUrlsAsPaths, workspaceLinks, type LinkTarget } from './workspace-links.ts';

type Plugins = NonNullable<StreamdownProps['rehypePlugins']>;

export function answerPlugins({ key, answer, resolve, found, defer = false }: { defer?: boolean; key: string; answer: string; resolve: (href: string) => LinkTarget; found: (href: string) => void }): Plugins {
  const { raw, sanitize, harden } = defaultRehypePlugins as Record<string, Plugins[number]>;
  const links = [workspaceLinks, { key, answer, resolve, found, defer }];
  return [raw, fileUrlsAsPaths, sanitize, links, harden].filter(Boolean) as Plugins;
}
