// Builds a single-file executable (Node Single Executable Application):
//   node build-exe.mjs            -> release/neon-arena.exe (Windows x64)
//   node build-exe.mjs --linux    -> release/neon-arena-linux (to smoke-test the pipeline)
//
// The Windows runtime (node.exe) is taken from the official `node-win-x64` npm
// package whose version equals the Node used for building: the SEA blob is only
// guaranteed to load in the same Node version.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const linux = process.argv.includes('--linux');
const ver = process.versions.node;
const out = 'release';
const tmp = 'dist/exe';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
mkdirSync(out, { recursive: true });

// 1) client bundle (dist/public) must exist
if (!existsSync('dist/public/main.js')) execFileSync('node', ['build.mjs'], { stdio: 'inherit' });

// 2) server -> one CommonJS file with `ws` bundled in (SEA needs a single script)
await build({
  entryPoints: ['src/server/exe.ts'],
  outfile: `${tmp}/bundle.cjs`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: true,
  external: ['bufferutil', 'utf-8-validate'], // optional native accelerators of ws
  logLevel: 'warning',
});

// 3) SEA blob with the client files embedded as assets
writeFileSync(
  `${tmp}/sea-config.json`,
  JSON.stringify({
    main: `${tmp}/bundle.cjs`,
    output: `${tmp}/sea.blob`,
    disableExperimentalSEAWarning: true,
    assets: { 'index.html': 'dist/public/index.html', 'main.js': 'dist/public/main.js' },
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', `${tmp}/sea-config.json`], { stdio: 'inherit' });

// 4) pick the runtime binary
const target = linux ? join(out, 'neon-arena-linux') : join(out, 'neon-arena.exe');
if (linux) {
  copyFileSync(process.execPath, target);
} else {
  execFileSync('npm', ['pack', `node-win-x64@${ver}`, '--pack-destination', tmp, '--silent'], { stdio: 'inherit' });
  const tgz = readdirSync(tmp).find((f) => f.startsWith('node-win-x64-') && f.endsWith('.tgz'));
  if (!tgz) throw new Error('node-win-x64 tarball not found');
  execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp]);
  copyFileSync(join(tmp, 'package', 'bin', 'node.exe'), target);
}

// 5) inject the blob
execFileSync(
  'npx',
  ['postject', target, 'NODE_SEA_BLOB', `${tmp}/sea.blob`, '--sentinel-fuse', FUSE, ...(linux ? [] : [])],
  { stdio: 'inherit' },
);
if (linux) chmodSync(target, 0o755);
console.log(`\nBuilt ${target}`);
