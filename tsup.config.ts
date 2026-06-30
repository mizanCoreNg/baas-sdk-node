import { defineConfig } from 'tsup';

// Build ESM + CJS + .d.ts. The generated typescript-axios client is bundled
// in (it is part of the package surface but only re-exported types are public).
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
