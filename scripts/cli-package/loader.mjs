// Load the included workspace sources without asking Node to strip third-party TypeScript.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
// Calling stripTypeScriptTypes makes Node print one ExperimentalWarning on every run. The person cannot act on it,
// so drop that single warning and pass every other warning and error through untouched.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const message = typeof warning === 'string' ? warning : warning?.message;
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? (typeof warning === 'object' ? warning?.name : undefined);
  if (type === 'ExperimentalWarning' && typeof message === 'string' && message.startsWith('stripTypeScriptTypes is an experimental feature')) return;
  return emitWarning(warning, ...rest);
};
const root = fileURLToPath(new URL('../', import.meta.url));
const names = JSON.parse(readFileSync(new URL('./workspace-map.json', import.meta.url), 'utf8'));
registerHooks({
  resolve(specifier, context, next) {
    const name = Object.keys(names).find((n) => specifier === n || specifier.startsWith(`${n}/`));
    if (!name) return next(specifier, context);
    const dir = resolve(root, names[name]);
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
    const key = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
    const target = pkg.exports?.[key];
    if (typeof target !== 'string') throw new Error(`No workspace export ${specifier}`);
    return { url: pathToFileURL(resolve(dir, target)).href, shortCircuit: true };
  },
  load(url, context, next) {
    if (url.startsWith(pathToFileURL(root).href) && url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
    }
    return next(url, context);
  },
});
