import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
// Invoke Node entry points directly: npm's Windows .bin shims break in paths containing &.
for (const args of [
  ['node_modules/typescript/bin/tsc', '-b'],
  ['node_modules/vite/bin/vite.js', 'build'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// WhiteNoise automatically serves precompressed sidecars without runtime work.
for (const entry of readdirSync('dist/assets')) {
  if (/\.(js|css)$/.test(entry)) {
    const path = join('dist/assets', entry);
    writeFileSync(path + '.gz', gzipSync(readFileSync(path), { level: 9 }));
  }
}
