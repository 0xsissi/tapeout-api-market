import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { archiveFiles, validateManifest } from '../../apps/marketplace/public/install.mjs';
function tar(name: string, kind = '0') { const h = Buffer.alloc(512); h.write(name); h.write('00000000000\0', 124, 12); h.fill(32, 148, 156); h.write(kind, 156, 1); h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8); return gzipSync(Buffer.concat([h, Buffer.alloc(1024)])); }
describe('public installer boundaries', () => {
  it('rejects foreign downloads, alternate chains, oversized archives, malformed hashes and unsafe versions', () => {
    const good = { product: 'Tapeout API Market', version: '0.2.0-bsc-pilot.1', chainId: 97, minimumNodeMajor: 22, artifact: { url: 'https://market.example/downloads/tam-client-0.2.0-bsc-pilot.1.tar.gz', sha256: 'a'.repeat(64), size: 100 } };
    expect(validateManifest(good, 'https://market.example/downloads/latest.json')).toBe(good);
    for (const bad of [{ ...good, chainId: 56 }, { ...good, version: '../x' }, { ...good, artifact: { ...good.artifact, url: 'https://other.example/downloads/tam-client-0.2.0-bsc-pilot.1.tar.gz' } }, { ...good, artifact: { ...good.artifact, sha256: 'bad' } }, { ...good, artifact: { ...good.artifact, size: 26 * 1024 * 1024 } }]) expect(() => validateManifest(bad, 'https://market.example/downloads/latest.json')).toThrow();
  });
  it('rejects traversal, absolute paths, links, Windows devices and private directories before extraction', () => {
    for (const name of ['../wallet.json', '/absolute', 'node_modules/x', '.git/config', 'folder/CON.txt', 'folder/../x', 'folder//x']) expect(() => archiveFiles(tar(name))).toThrow('Unsafe');
    expect(() => archiveFiles(tar('link', '2'))).toThrow('Unsafe'); expect(() => archiveFiles(tar('package.json'))).toThrow('Incomplete');
  });
});
