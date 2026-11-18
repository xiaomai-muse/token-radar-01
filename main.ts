// Token Radar entrypoint (Node 22 stdlib only, deterministic).
//
// Reads /input/snapshot.json (or --input <file|dir>), computes the peer-calibrated pre-token board
// via lib/model.ts, writes /output/board.json and /output/data.js, copies dashboard/ and screenshots/
// to /output, and writes /output/dossier.json via vendor/makefun-board.ts.
//
// Local run:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

function copyDirFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  const entries = readdirSync(from).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    copied.push(name);
  }
  return copied;
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token-radar: missing snapshot at ${inputFile}\n`);
  process.exit(2);
}

const outDir = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);

const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token-radar: board failed validation: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

const dashFiles = copyDirFiles(join(here, 'dashboard'), join(outDir, 'dashboard'));
if (!dashFiles.includes('index.html') || !dashFiles.some((f) => f.endsWith('.css')) || !dashFiles.some((f) => f.endsWith('.js'))) {
  process.stderr.write(`token-radar: dashboard/ must contain index.html, at least one .css, and at least one .js\n`);
  process.exit(1);
}

const shotFiles = copyDirFiles(join(here, 'screenshots'), join(outDir, 'screenshots'));
if (shotFiles.length < 3) {
  process.stderr.write(`token-radar: screenshots/ holds ${shotFiles.length} image(s); expected 3 (board, detail, filtered)\n`);
  process.exit(1);
}
for (const name of shotFiles) {
  if (!SAFE_NAME.test(name)) {
    process.stderr.write(`token-radar: invalid screenshot filename ${name}\n`);
    process.exit(1);
  }
}

const dossier = buildDossier(outDir, {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: SCREENSHOT_CAPS,
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
});
writeFileSync(join(outDir, 'dossier.json'), dossier);

process.stdout.write(
  `token-radar: ${snapshot.protocols.length} protocols | ${snapshot.watchlist.length} watchlist | ${board.length} ranked (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token-radar: wrote board.json, data.js, dashboard (${dashFiles.length} files), screenshots (${shotFiles.length} images), dossier.json (${Buffer.byteLength(dossier)} bytes)\n`,
);
