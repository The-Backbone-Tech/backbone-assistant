// Types for brand.mjs, which the app's build and Vite config import.
export interface Brand {
  name: string;
  appId: string;
  light: string;
  dark: string;
}
export const DEFAULT_BRAND: Readonly<Brand>;
export function distributionProblems(distribution: unknown): string[];
export function loadBrand(env?: Record<string, string | undefined>, cwd?: string): Brand;
export function loadBuildBrand(env?: Record<string, string | undefined>, cwd?: string): Brand;
