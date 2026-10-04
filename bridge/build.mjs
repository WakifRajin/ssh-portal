// Builds the bridge into one executable (Node.js single executable app), so
// users can download and run it without installing Node.js.
//
//   node build.mjs                      -> dist/ssh-portal-bridge-<os>-<arch>[.exe]
//   APP_URL=https://you.github.io/ssh-portal/ REPO=you/ssh-portal node build.mjs
//
// Must run on the target OS (CI builds each platform on its own runner).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
const arch = process.arch;
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const dist = path.resolve('dist');
const exe = path.join(dist, `ssh-portal-bridge-${os}-${arch}${isWin ? '.exe' : ''}`);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

// 1. one CommonJS file with every dependency inlined
await build({
  entryPoints: ['server.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(dist, 'bridge.cjs'),
  // optional native speed-ups; each is loaded in a try/catch with a JS fallback
  external: ['cpu-features', 'bufferutil', 'utf-8-validate', '*.node'],
  define: {
    'import.meta.url': 'undefined',
    'process.env.SSH_PORTAL_BUILD_APP_URL': JSON.stringify(process.env.APP_URL || ''),
    'process.env.SSH_PORTAL_BUILD_REPO': JSON.stringify(process.env.REPO || ''),
  },
  logLevel: 'warning',
  logOverride: { 'empty-import-meta': 'silent' },
});

// 2. SEA preparation blob
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({ main: path.join(dist, 'bridge.cjs'), output: path.join(dist, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 3. copy the node binary and inject the blob
fs.copyFileSync(process.execPath, exe);
if (isMac) run('codesign', ['--remove-signature', exe]);
run(process.execPath, [
  require.resolve('postject/dist/cli.js'),
  exe,
  'NODE_SEA_BLOB',
  path.join(dist, 'sea-prep.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(isMac ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);
if (isMac) run('codesign', ['--sign', '-', exe]);
if (!isWin) fs.chmodSync(exe, 0o755);

for (const f of ['bridge.cjs', 'sea-config.json', 'sea-prep.blob']) fs.rmSync(path.join(dist, f));
console.log(`\nBuilt ${path.relative(process.cwd(), exe)} (${(fs.statSync(exe).size / 1048576).toFixed(0)} MB)`);
