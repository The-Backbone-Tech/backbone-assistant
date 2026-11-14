// Shared exact-value scrub used by adapters and the Host's work record. Values stay in the Host.
export function scrubKnownCredentials(text: string, values: readonly string[]): string {
  for (const value of [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length)) text = text.split(value).join('[credential]');
  return text;
}

/**
 * The one assignment that is shown as written: `key=lambda x: ...`, the sort, max and min keyword
 * argument. It is recognised from syntax a secret cannot have: the bare name `key`, the exact word
 * `lambda`, then a parameter list and a colon. Every other value after a key-like name, including a
 * name, a call or a quoted string, is treated as a secret, because nothing in the text can show it is not.
 */
function lambdaKeyArgument(text: string, offset: number, name: string, value: string): boolean {
  if (name !== 'key' || value !== 'lambda') return false;
  return /^key\s*=\s*lambda[ \t]+[A-Za-z_*][A-Za-z0-9_]*(?:[ \t]*,[ \t]*\*{0,2}[A-Za-z_][A-Za-z0-9_]*)*[ \t]*:/.test(text.slice(offset));
}

/** Preserve ordinary paths and lowercase hex; credential context and known values take precedence. */
export function redactWorkText(text: string, values: readonly string[]): string {
  return scrubKnownCredentials(text, values)
    .replace(/(\bauthorization\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"'\\]+/gi, '$1[credential]')
    .replace(/\b((?:[A-Za-z0-9]+[-_])*(?:key|token|secret|password|authorization))(\s*:\s*(?:(?:bearer|basic)\s+)?)("[^"]*"|'[^']*'|[^\s"'\\]+)/gi, '$1$2[credential]')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s;|&]+)/g, (all, name: string, equals: string, value: string, offset: number, whole: string) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name) && !lambdaKeyArgument(whole, offset, name, value) ? `${name}${equals}[credential]` : all)
    .replace(/\b(?:sk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|hf_[A-Za-z0-9]{16,})\b/g, '[credential]')
    .replace(/[A-Za-z0-9_~.+/=-]{32,}/g, token => {
      // A path keeps its slashes between ordinary name segments; a base64 secret (an AWS secret key, for example)
      // can contain '/' too, so a relative token counts as a path only when every segment looks like a name:
      // all lowercase letters and digits, or containing a '-', '_' or '.', or the token ends in a file extension.
      const pathShaped = /^[~.\/]/.test(token) || (token.includes('/') && !/[+=]/.test(token) && token.split('/').filter(Boolean).length >= 2 && token.split('/').filter(Boolean).every(part => part.length <= 64) && (/\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(token) || token.split('/').filter(Boolean).every(part => /^[a-z0-9]+$/.test(part) || /[-_.]/.test(part))));
      if (pathShaped || /^[a-f0-9]+$/.test(token) || !/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) return token;
      const counts = new Map<string, number>();
      for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
      const entropy = [...counts.values()].reduce((sum, n) => sum - (n / token.length) * Math.log2(n / token.length), 0);
      return entropy >= 3.5 ? '[credential]' : token;
    });
}
