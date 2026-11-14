// The brand profile a build uses: the `brand` of the distribution named by BACKBONE_DISTRIBUTION (a
// path to its distribution.json), or the neutral default. The app shell reads its name from here and
// nowhere else, so a distribution rebrands it without a fork (schemas/distribution.schema.json).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const DEFAULT_BRAND = Object.freeze({ name: 'Assistant', appId: 'org.example.assistant', light: 'warm', dark: 'neutral' });
const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '../../schemas/distribution.schema.json');
let validator;

export function distributionProblems(distribution) {
  if (!validator) validator = new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(SCHEMA, 'utf8')));
  return validator(distribution) ? [] : validator.errors.map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
}

const SOURCE = Symbol('distribution file');
const sourced = (brand, path) => Object.defineProperty(brand, SOURCE, { value: path });

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';

/**
 * The resolved brand. A distribution that fails its schema stops the build: a brand is never guessed.
 * A relative path is read from where the command was typed (pnpm's INIT_CWD), not the package folder.
 */
export function loadBrand(env = process.env, cwd = env.INIT_CWD ?? process.cwd()) {
  const file = env.BACKBONE_DISTRIBUTION;
  if (!file) return sourced({ ...DEFAULT_BRAND }, null);
  const path = resolve(cwd, file);
  const distribution = JSON.parse(readFileSync(path, 'utf8'));
  const problems = distributionProblems(distribution);
  if (problems.length) throw new Error(`${path}: not a valid distribution: ${problems.join('; ')}`);
  const { brand } = distribution;
  // The icon is a file beside the distribution; the build takes its path, and a missing one stops it.
  const icon = brand.icon ? join(dirname(path), brand.icon) : undefined;
  if (icon && !existsSync(icon)) throw new Error(`${path}: its icon ${icon} is not there`);
  return sourced({ ...DEFAULT_BRAND, appId: `org.example.${slug(brand.name)}`, ...brand, ...(icon ? { icon } : {}) }, path);
}

/** Guard actual file provenance, even if a future loader adds a fallback with the default name. */
export function loadBuildBrand(env = process.env, cwd = env.INIT_CWD ?? process.cwd()) {
  const brand = loadBrand(env, cwd);
  const selected = brand[SOURCE];
  if (!env.BACKBONE_DISTRIBUTION && selected !== null) throw new Error('Default build selected a distribution. Set BACKBONE_DISTRIBUTION explicitly; a default build must not select any distribution file.');
  if (env.BACKBONE_DISTRIBUTION && selected !== resolve(cwd, env.BACKBONE_DISTRIBUTION)) throw new Error('Build selected a distribution other than the explicit BACKBONE_DISTRIBUTION input.');
  return brand;
}
