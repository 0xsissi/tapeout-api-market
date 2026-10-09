import fs from 'node:fs/promises';
import path from 'node:path';

// Explicitly configured operator authority for this pilot seller. No client can set it.
export async function syncApprovedBuyers({ origin, file, fetcher = fetch }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('Admission authority requires an exact HTTPS origin');
  if (!path.isAbsolute(file)) throw new Error('Approved buyers file must be absolute');
  const response = await fetcher(origin + '/api/admission/approved', { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Admission authority unavailable');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 2_000_000) throw new Error('Approval manifest too large'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const address = v => typeof v === 'string' && /^0x[\da-f]{40}$/i.test(v);
  if (value.version !== 1 || !Array.isArray(value.grants) || value.grants.length > 20000 || value.grants.some(g => !address(g.address) || !address(g.sellerAddress) || !address(g.poolAddress) || g.chainId !== 97 || !['USDC', 'BEM'].includes(g.currency) || !Number.isSafeInteger(g.expiresAt))) throw new Error('Invalid approval manifest');
  const clean = { version: 1, grants: value.grants.map(g => ({ address: g.address, sellerAddress: g.sellerAddress, poolAddress: g.poolAddress, chainId: 97, currency: g.currency, expiresAt: g.expiresAt })) };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.sync-' + process.pid; await fs.writeFile(temp, JSON.stringify(clean), { mode: 0o600 }); await fs.rename(temp, file);
  return clean.grants.length;
}
export async function startAdmissionSync(options) {
  let busy = false;
  const refresh = async () => { if (busy) return; busy = true; try { await syncApprovedBuyers(options); } catch { console.warn('Buyer approval refresh unavailable; existing grants retain their original expiry.'); } finally { busy = false; } };
  await refresh(); const timer = setInterval(refresh, 30000); timer.unref(); return () => clearInterval(timer);
}
