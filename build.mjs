// Bundles client (browser IIFE) and server (Node ESM) with esbuild.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/public', { recursive: true });
cpSync('src/client/index.html', 'dist/public/index.html');

const clientOpts = {
  entryPoints: ['src/client/main.ts'],
  outfile: 'dist/public/main.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

const serverOpts = {
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external', // `ws` is installed in node_modules at runtime
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(clientOpts);
  await ctx.watch();
  console.log('[build] watching client…');
} else {
  await Promise.all([build(clientOpts), build(serverOpts)]);
}
