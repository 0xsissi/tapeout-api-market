import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startBootstrapStatusServer } from './bootstrap-status-server.mjs';

describe('public bootstrap status', () => {
  let server: Awaited<ReturnType<typeof startBootstrapStatusServer>> | undefined;
  afterEach(async () => { await server?.stop(); });

  it('publishes discovery peers and only public health fields, and rejects writes', async () => {
    const peers = ['/dns4/bootstrap.example.com/tcp/9090/p2p/PEER'];
    server = await startBootstrapStatusServer({
      port: 0,
      getPeers: () => peers,
      getStatus: () => ({ peerId: 'PEER', connections: 2, uptimeSeconds: 15, privateKey: 'must-not-be-published' }),
    });
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok', role: 'bootstrap-relay', peerId: 'PEER', connections: 2, uptimeSeconds: 15 });
    const manifest = await (await fetch(`${base}/bootstrap.json`)).json();
    expect(manifest.peers).toEqual(peers);
    peers.push('/dns4/backup.example.com/tcp/9090/p2p/BACKUP');
    expect((await (await fetch(`${base}/bootstrap.json`)).json()).peers).toHaveLength(2);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/bootstrap.key`)).status).toBe(404);
    const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server!.port, path: 'http://[' }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      }).once('error', reject);
    });
    expect(malformedStatus).toBe(400);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
