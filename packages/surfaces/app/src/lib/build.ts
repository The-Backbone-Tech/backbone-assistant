/** Public, path-free provenance embedded by the compiler, identical in renderer and main. */
export interface BuildIdentity {
  revision: string | null;
  dirty: boolean | null;
  gitSourceHash: string | null;
  id: string;
  builtAt: string;
  version: string;
}
declare const __BUILD__: BuildIdentity | undefined;
export const compiledBuild: BuildIdentity | undefined = typeof __BUILD__ === 'undefined' ? undefined : __BUILD__;
