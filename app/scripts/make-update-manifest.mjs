/**
 * Generates the Tauri updater manifest (latest.json) for a release.
 *
 * Reads the app version from src-tauri/tauri.conf.json, the NSIS installer
 * and its minisign signature from target/release/bundle/nsis/, and writes
 * src-tauri/target/release/bundle/latest.json — upload it to the GitHub
 * release alongside the installer. The updater feed
 * (…/releases/latest/download/latest.json) always resolves to the newest.
 *
 * Run AFTER a signed `npm run tauri build` (needs TAURI_SIGNING_PRIVATE_KEY
 * set, or the .sig file won't exist).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const nsisDir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis');

const exeName = `SynthCreator3D_${version}_x64-setup.exe`;
const exePath = join(nsisDir, exeName);
const sigPath = `${exePath}.sig`;
for (const [path, what] of [[exePath, 'installer'], [sigPath, 'signature (sign the build via TAURI_SIGNING_PRIVATE_KEY)']]) {
  if (!existsSync(path)) {
    console.error(`missing ${what}: ${path}`);
    process.exit(1);
  }
}

const signature = readFileSync(sigPath, 'utf8').trim();
const manifest = {
  version,
  notes: `SynthCreator3D v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      url: `https://github.com/GhostNoodl/SynthCreator3D/releases/download/v${version}/${exeName}`,
      signature,
    },
  },
};

const outPath = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'latest.json');
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${outPath}`);
console.log(`version: ${version}`);
console.log(`sig present: ${signature.length} chars`);
// sanity: the NSIS dir shouldn't carry other stale installers
for (const f of readdirSync(nsisDir).filter((f) => f.endsWith('.exe') && f !== exeName)) {
  console.warn(`note: stale installer also present: ${f}`);
}
