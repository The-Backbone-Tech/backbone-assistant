/** Canonicalize the exact address handed to Chromium, before any navigation or handoff. */
export function browserAddress(value: string): string | undefined {
  if (value.length > 8192 || /[\\\u0000-\u001f\u007f]/u.test(value)) return;
  const address = value.trim();
  if (!address || /\s/u.test(address) || address.startsWith('//')) return;
  try {
    let url: URL;
    if (/^https?:\/\//i.test(address)) url = new URL(address);
    else {
      // A port on a bare host is not a scheme. Other explicit schemes stay refused.
      if (/^[a-z][a-z\d+.-]*:/i.test(address) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(address)) return;
      url = new URL(`https://${address}`);
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      const mapped = /^\[::ffff:([\da-f]+):([\da-f]+)\]$/i.exec(host);
      const words = mapped?.slice(1).map(word => parseInt(word, 16));
      const ipv4 = words ? [words[0] >> 8, words[0] & 255, words[1] >> 8, words[1] & 255] : host.split('.').map(Number);
      const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        host === '[::1]' || /^\[f[cd][\da-f]{2}:/i.test(host) || /^\[fe[89ab][\da-f]:/i.test(host) ||
        (ipv4.length === 4 && ipv4.every(Number.isInteger) && (ipv4[0] === 0 || ipv4[0] === 127 || ipv4[0] === 10 ||
          (ipv4[0] === 169 && ipv4[1] === 254) || (ipv4[0] === 192 && ipv4[1] === 168) || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)));
      url = new URL(`${local ? 'http' : 'https'}://${address}`);
    }
    if (url.username || url.password || address.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].includes('@')) return;
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.href.length <= 8192 ? url.href : undefined;
  } catch { return; }
}

/** Subresources may use Chromium's local document schemes and live-preview sockets. */
export function browserResourceAllowed(value: string): boolean {
  try { return ['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:'].includes(new URL(value).protocol) || value === 'about:blank' || value === 'about:srcdoc'; }
  catch { return false; }
}
