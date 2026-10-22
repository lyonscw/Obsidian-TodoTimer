import * as esbuild from 'esbuild';

const production = process.argv.includes('production');
const options = {
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2021',
  sourcemap: production ? false : 'inline',
  minify: production,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/common', '@lezer/highlight', '@lezer/lr'],
  banner: { js: '/* TodoTimer — generated plugin bundle. Source lives in src/. */' },
  logLevel: 'info',
};
if (production) {
  await esbuild.build(options);
} else {
  const context = await esbuild.context(options);
  await context.watch();
}
