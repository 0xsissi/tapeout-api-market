#!/usr/bin/env node
// Review this file before running it. It installs a BSC pilot client, not a wallet or login.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_ARCHIVE = 25 * 1024 * 1024;
export function validateManifest(value, manifestURL) {
  const source = new URL(manifestURL), url = new URL(value?.artifact?.url);
  if (!((source.protocol === 'https:') || (source.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(source.hostname))) || source.username || source.password || url.origin !== source.origin || url.username || url.password || url.search || url.hash) throw new Error('Download must use the manifest HTTPS origin (or loopback test origin)');
  if (value.product !== 'Tapeout API Market' || value.chainId !== 97 || value.minimumNodeMajor !== 22 || !/^0\.2\.0-bsc-pilot\.[1-9]\d{0,5}$/.test(value.version) || !/^[a-f0-9]{64}$/.test(value.artifact.sha256) || !Number.isSafeInteger(value.artifact.size) || value.artifact.size < 1 || value.artifact.size > MAX_ARCHIVE || url.pathname !== `/downloads/tam-client-${value.version}.tar.gz`) throw new Error('Unsupported release manifest');
  return value;
}
export function archiveFiles(gzip) {
  const data = gunzipSync(gzip, { maxOutputLength: 100 * 1024 * 1024 });
  const files = [], seen = new Set(); let offset = 0, ended = false;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512); offset += 512;
    if (header.every(v => v === 0)) { ended = true; break; }
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const octal = (start, length) => { const s = field(start, length).trim(); if (!/^[0-7]+$/.test(s)) throw new Error('Invalid archive number'); return parseInt(s, 8); };
    const sum = [...header].reduce((s, v, i) => s + (i >= 148 && i < 156 ? 32 : v), 0);
    if (sum !== octal(148, 8)) throw new Error('Invalid archive checksum');
    const name = field(0, 100), size = octal(124, 12), kind = field(156, 1);
    // Our release builder emits only ordinary ASCII-named files. No links, PAX or directories.
    if (field(345, 155) || !['0', ''].includes(kind) || !/^[a-zA-Z0-9_./-]{1,99}$/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || p.endsWith('.')) || /(^|\/)(\.git|node_modules|\.env|wallet\.json)(\/|$)/.test(name) || seen.has(name.toLowerCase()) || !Number.isSafeInteger(size) || size < 0 || offset + size > data.length) throw new Error('Unsafe or unsupported archive entry');
    seen.add(name.toLowerCase()); files.push({ name, bytes: data.subarray(offset, offset + size) });
    if (files.length > 2000) throw new Error('Too many release files');
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || data.subarray(offset).some(v => v !== 0) || !seen.has('packages/cli/dist/index.js') || !seen.has('pnpm-lock.yaml') || !seen.has('package.json')) throw new Error('Incomplete release archive');
  return files;
}
async function download(url, limit) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('Download exceeds size limit'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function command(exe, args, cwd) {
  await new Promise((resolve, reject) => { const child = spawn(exe, args, { cwd, shell: false, windowsHide: true, stdio: 'inherit' }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Installation command failed (${code})`))); });
}
async function npmCLI() {
  const prefix = path.dirname(process.execPath);
  const candidates = [path.join(prefix, 'node_modules/npm/bin/npm-cli.js'), path.resolve(prefix, '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js'];
  for (const file of candidates) try { if ((await fs.stat(file)).isFile()) return file; } catch {}
  throw new Error('npm is missing from this Node.js installation. Install Node.js 22+ with npm from nodejs.org.');
}
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let current = directory;
  while (true) { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Install path cannot contain symbolic links'); const parent = path.dirname(current); if (parent === current) break; current = parent; }
}
export async function install({ manifestURL = 'https://shenjige.xyz/downloads/latest.json', directory = path.join(process.env.HOME || os.homedir(), '.tam/client') } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  // Validate the source before fetching anything.
  const source = new URL(manifestURL);
  if (source.username || source.password || (source.protocol !== 'https:' && !(source.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(source.hostname)))) throw new Error('Use an HTTPS manifest or a loopback test URL');
  const release = validateManifest(JSON.parse((await download(source.href, 16384)).toString('utf8')), source.href);
  directory = path.resolve(directory); await privateDirectory(directory);
  const lock = path.join(directory, 'install.lock'); const handle = await fs.open(lock, 'wx', 0o600);
  try {
    const releases = path.join(directory, 'releases'); await privateDirectory(releases);
    const destination = path.join(releases, release.version);
    let existing; try { existing = JSON.parse(await fs.readFile(path.join(destination, 'installed.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing && existing.sha256 !== release.artifact.sha256) throw new Error('This version already exists with a different hash; stopped.');
    if (!existing) {
      try { await fs.lstat(destination); throw new Error('An incomplete version directory exists. Keep it for inspection and choose a separate --directory.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const archive = await download(release.artifact.url, MAX_ARCHIVE);
      if (archive.length !== release.artifact.size || createHash('sha256').update(archive).digest('hex') !== release.artifact.sha256) throw new Error('Client archive hash or size mismatch');
      const files = archiveFiles(archive), staging = path.join(releases, '.staging-' + randomUUID());
      await fs.mkdir(staging, { mode: 0o700 });
      for (const file of files) { const full = path.join(staging, ...file.name.split('/')); await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, file.bytes, { flag: 'wx', mode: 0o644 }); }
      // pnpm uses absolute junction targets on Windows: install only after the final path exists.
      await fs.rename(staging, destination);
      console.log('Verified client archive. Installing locked production dependencies without lifecycle scripts…');
      await command(process.execPath, [await npmCLI(), 'exec', '--yes', '--package=pnpm@10.18.3', '--', 'pnpm', 'install', '--prod', '--frozen-lockfile', '--ignore-scripts'], destination);
      await command(process.execPath, ['packages/cli/dist/index.js', 'join', '--help'], destination);
      await fs.writeFile(path.join(destination, 'installed.json'), JSON.stringify({ version: release.version, sha256: release.artifact.sha256, installedAt: new Date().toISOString() }), { mode: 0o600 });
    }
    await privateDirectory(destination);
    const wrapper = `import {spawn} from 'node:child_process';\nconst root=${JSON.stringify(destination)};\nconst child=spawn(process.execPath,[${JSON.stringify(path.join(destination, 'packages/cli/dist/index.js'))},...process.argv.slice(2)],{cwd:root,stdio:'inherit',shell:false,windowsHide:true,env:{...process.env,SKIP_PNPM_BUILD:'1'}});\nchild.on('error',()=>{console.error('TAM could not start');process.exitCode=1});\nchild.on('exit',code=>{process.exitCode=code??1});\n`;
    const launcher = path.join(directory, 'tam.mjs'), temp = launcher + '.' + process.pid + '.tmp'; await fs.writeFile(temp, wrapper, { mode: 0o700 }); await fs.rename(temp, launcher);
    return { installed: true, version: release.version, chainId: 97, launcher, walletsCreated: 0, transactionsSent: 0, next: 'Read skill.md, confirm role/currency/model/budget, then run node <launcher> --payment-token USDC join prepare …' };
  } finally { await handle.close(); await fs.unlink(lock); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--manifest', '--directory'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node install.mjs [--manifest HTTPS_URL] [--directory PATH]'); options[args[i] === '--manifest' ? 'manifestURL' : 'directory'] = args[i + 1]; }
  try { console.log(JSON.stringify(await install(options), null, 2)); } catch (e) { console.error('TAM installation stopped: ' + e.message); process.exitCode = 1; }
}
