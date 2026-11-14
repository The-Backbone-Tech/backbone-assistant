// The brand profile the app was built with: the `brand` of the distribution named by
// BACKBONE_DISTRIBUTION at build time (scripts/lib/brand.mjs at the repository root). The shell never
// names itself in code, so a distribution rebrands it without a fork.
export interface Brand {
  name: string;
  appId: string;
  light: string;
  dark: string;
}

declare const __BRAND__: Brand | undefined;

// Unit tests import components without a build; they see the neutral default.
export const brand: Brand = typeof __BRAND__ === 'undefined' ? { name: 'Assistant', appId: 'org.example.assistant', light: 'warm', dark: 'neutral' } : __BRAND__;
