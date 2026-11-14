import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// The brand profile (BACKBONE_DISTRIBUTION, or the neutral default): the only source of the app's name.
import { loadBuildBrand } from '../../../scripts/lib/brand.mjs';

const brand = loadBuildBrand();

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), { name: 'brand', transformIndexHtml: (html) => html.replace('%BRAND_NAME%', brand.name.replace(/[&<>"]/g, '')) }],
  define: { __BRAND__: JSON.stringify(brand) },
  // Packaging copies module tsconfigs here. They are not renderer inputs: watching them
  // can force a full page reload while a person is using a dialog or editing a draft.
  server: { watch: { ignored: ['**/dist/**'] } },
  build: { assetsInlineLimit: 0, outDir: 'dist/renderer', emptyOutDir: true, chunkSizeWarningLimit: 4000, minify: process.env.BACKBONE_DEBUG ? false : 'oxc', sourcemap: !!process.env.BACKBONE_DEBUG },
});
