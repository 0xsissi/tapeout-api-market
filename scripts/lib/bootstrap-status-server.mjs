import http from 'node:http';

export async function startBootstrapStatusServer({ host = '127.0.0.1', port, getStatus, getPeers }) {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      response.writeHead(400);
      response.end(JSON.stringify({ error: 'invalid_url' }));
      return;
    }
    let body;
    if (pathname === '/health') {
      const status = getStatus();
      body = { status: 'ok', role: 'bootstrap-relay', peerId: status.peerId, connections: status.connections, uptimeSeconds: status.uptimeSeconds };
    } else if (pathname === '/bootstrap.json') {
      body = { role: 'bootstrap', peers: getPeers(), updatedAt: new Date().toISOString() };
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    response.writeHead(200);
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    async stop() {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
