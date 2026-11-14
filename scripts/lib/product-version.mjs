// The one place the product version number lives. The app's build and packaging scripts and the
// command line's packer read it; BACKBONE_APP_VERSION still overrides it for a one-off build.
import { readFileSync } from 'node:fs';

export const PRODUCT_VERSION = JSON.parse(readFileSync(new URL('./product.json', import.meta.url), 'utf8')).version;
export const productVersion = () => process.env.BACKBONE_APP_VERSION ?? PRODUCT_VERSION;
