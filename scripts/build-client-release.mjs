import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { archiveFiles } from '../apps/marketplace/public/install.mjs';
import { auditTrackedPrivacy, privacyIssues, privateTermsFromEnv } from './lib/privacy-check.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), [output, origin = 'https://shenjige.xyz', version = '0.2.0-bsc-pilot.1'] = process.argv.slice(2);
if (!output || !path.isAbsolute(output) || !/^0\.2\.0-bsc-pilot\.[1-9]\d{0,5}$/.test(version)) throw new Error('Usage: build-client-release.mjs ABSOLUTE_EXTERNAL_DIRECTORY [ORIGIN] [VERSION]');
const relative = path.relative(root, output); if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Release output must be outside Git');
auditTrackedPrivacy(root);
const files = new Map();
function add(name, bytes = fs.readFileSync(path.join(root, name))) { if (!/^[a-zA-Z0-9_./-]{1,99}$/.test(name)) throw new Error('Archive filename unsupported'); files.set(name, bytes); }
function walk(folder) { for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) { const name = folder + '/' + entry.name; if (entry.isDirectory()) walk(name); else if (entry.isFile()) add(name); else throw new Error('Links are not release files'); } }
const packages = ['shared', 'crypto', 'p2p-node', 'consumer-gateway', 'provider-gateway', 'cli'];
for (const name of packages) { const folder = `packages/${name}`; add(folder + '/package.json'); walk(folder + '/dist'); }
walk('apps/client/public');
// Scripts only from tracked source, never .env, private state, reports or deployment material.
for (const name of execFileSync('git', ['ls-files', 'scripts'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(n => n.endsWith('.mjs') && !/\.test\./.test(n))) add(name);
add('scripts/lib/admission-sync.mjs'); add('scripts/lib/market-admission.mjs');
add('pnpm-lock.yaml'); add('pnpm-workspace.yaml');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// Frozen install checks dev specifiers too; --prod still omits the dev dependencies.
add('package.json', Buffer.from(JSON.stringify({ ...packageJson, name: 'tapeout-api-market-pilot-client', version: '0.2.0', type: 'module', engines: { node: '>=22' } }, null, 2)));
add('RELEASE-NOTICE.txt', Buffer.from('Tapeout API Market (TAM) — BSC Testnet pilot client\nSource project: https://github.com/0xsissi/tapeout-api-market\nThird-party dependencies retain their own licenses and notices in the dependency installation.\nNo private keys, login sessions, wallets or server configuration are included.\n'));
for (const [name, bytes] of files) {
  const issues = privacyIssues(name, bytes, privateTermsFromEnv());
  if (issues.length) throw new Error('Private data in release file: ' + JSON.stringify({ file: name, issues }));
}
const parts = [];
for (const [name, bytes] of [...files].sort()) { const header = Buffer.alloc(512); header.write(name, 0, 100, 'ascii'); const oct = (value, start, length) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', start, length, 'ascii'); oct(0o644, 100, 8); oct(0, 108, 8); oct(0, 116, 8); oct(bytes.length, 124, 12); oct(0, 136, 12); header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6); header.write('00', 263, 2); const checksum = [...header].reduce((a, b) => a + b, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8); parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)); }
parts.push(Buffer.alloc(1024)); const archive = gzipSync(Buffer.concat(parts), { level: 9 }); archiveFiles(archive);
fs.mkdirSync(output, { recursive: true }); const name = `tam-client-${version}.tar.gz`;
fs.writeFileSync(path.join(output, name), archive);
const manifest = { product: 'Tapeout API Market', version, chainId: 97, minimumNodeMajor: 22, artifact: { url: new URL('/downloads/' + name, origin).href, sha256: createHash('sha256').update(archive).digest('hex'), size: archive.length }, builtAt: new Date().toISOString(), files: files.size, automaticAccess: false };
fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(manifest, null, 2)); console.log(JSON.stringify(manifest, null, 2));
