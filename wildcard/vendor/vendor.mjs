// Vendors @colyseus/sdk 0.17 into this folder as ONE local ESM file (no CDN at runtime, no build step for the cabinet).
// Needs the npm registry once, so run it on a machine (or agent) with network access:
//
//     node wildcard/vendor/vendor.mjs            # newest 0.17.x
//     node wildcard/vendor/vendor.mjs 0.17.3     # an exact 0.17.x
//
// Output (commit all three): colyseus-sdk.mjs, VERSION (exact pinned version + sha256), LICENSE-colyseus-sdk.
// The script refuses any version that is not 0.17.x, because the game server speaks Colyseus 0.17.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const want = process.argv[2] || '0.17';
if (!/^0\.17(\.\d+)?$/.test(want)) { console.error('Only 0.17.x is allowed (the server runs Colyseus 0.17).'); process.exit(1); }

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' }).trim();
const work = mkdtempSync(path.join(tmpdir(), 'wc-vendor-'));
writeFileSync(path.join(work, 'package.json'), '{"name":"wc-vendor","private":true,"type":"module"}\n');

const exact = run('npm', ['view', `@colyseus/sdk@${want}`, 'version', '--json'], work);
const version = JSON.parse(exact);
const pinned = Array.isArray(version) ? version[version.length - 1] : version;
if (!/^0\.17\.\d+$/.test(pinned)) { console.error(`Unexpected version "${pinned}"`); process.exit(1); }

run('npm', ['install', '--no-audit', '--no-fund', '--save-exact', `@colyseus/sdk@${pinned}`, 'esbuild'], work);
writeFileSync(path.join(work, 'entry.js'), "export { Client } from '@colyseus/sdk';\n");
const out = path.join(work, 'out.mjs');
run(path.join(work, 'node_modules', '.bin', 'esbuild'), ['entry.js', '--bundle', '--format=esm', '--platform=browser', '--target=es2020', '--minify', `--outfile=${out}`, '--legal-comments=inline'], work);

const pkgDir = path.join(work, 'node_modules', '@colyseus', 'sdk');
const licence = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map((f) => path.join(pkgDir, f)).find((f) => existsSync(f));
if (!licence) { console.error('The package has no LICENSE file; not vendoring it.'); process.exit(1); }
cpSync(licence, path.join(here, 'LICENSE-colyseus-sdk'));

const body = readFileSync(out);
const header = `/* @colyseus/sdk ${pinned} (MIT), bundled by wildcard/vendor/vendor.mjs. Licence: LICENSE-colyseus-sdk. Do not edit by hand. */\n`;
const file = Buffer.concat([Buffer.from(header), body]);
writeFileSync(path.join(here, 'colyseus-sdk.mjs'), file);
const sha = createHash('sha256').update(file).digest('hex');
writeFileSync(path.join(here, 'VERSION'), `@colyseus/sdk ${pinned}\nsha256 ${sha}\n`);
console.log(`Vendored @colyseus/sdk ${pinned} (${file.length} bytes, sha256 ${sha.slice(0, 12)}...). Commit colyseus-sdk.mjs, VERSION and LICENSE-colyseus-sdk.`);
