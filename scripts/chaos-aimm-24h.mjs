import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const reportDir = path.resolve(process.env.AIMM_CHAOS_REPORT_DIR ?? 'report/chaos');
const durationMs = Number(process.env.AIMM_CHAOS_DURATION_MS ?? String(24 * 60 * 60 * 1000));
const accelerated = process.env.AIMM_CHAOS_REALTIME !== 'true';

async function main() {
  const { Harness } = await import('../packages/aimm-testkit/dist/index.js');
  const makers = Array.from({ length: 5 }, (_, index) => ({
    id: `M${index + 1}`,
    p0: 2 + index * 0.1,
    alpha: 1,
    credits: 10_000,
    modelWeights: { sonnet: 1 },
  }));
  const buyers = Array.from({ length: 20 }, (_, index) => ({
    id: `B${index + 1}`,
    model: 'sonnet',
    requestCount: accelerated ? 200 : 2000,
    totalTokens: 100,
  }));

  const result = await new Harness({
    makers,
    buyers,
    routing: 'softmax',
    beta: 3,
    seed: 24,
  }).run(durationMs);

  const summary = {
    pass: result.upstream429Count === 0 && result.completedRequests > 0,
    mode: accelerated ? 'accelerated' : 'realtime',
    durationMs,
    completedRequests: result.completedRequests,
    upstream429Count: result.upstream429Count,
    routingHits: result.routingHits,
  };

  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(path.join(reportDir, `chaos-24h-${yyyymmdd()}.md`), formatChaosMarkdown(summary), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.pass) process.exitCode = 1;
}

function yyyymmdd() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}${pick('month')}${pick('day')}`;
}

function formatChaosMarkdown(summary) {
  return [
    `# AIMM Chaos 24h ${yyyymmdd()}`,
    '',
    `Status: ${summary.pass ? 'PASS' : 'FAIL'}`,
    `Mode: ${summary.mode}`,
    `Duration ms: ${summary.durationMs}`,
    `Completed requests: ${summary.completedRequests}`,
    `Upstream 429 count: ${summary.upstream429Count}`,
    '',
    '## Routing Hits',
    '',
    ...Object.entries(summary.routingHits).map(([makerId, hits]) => `- ${makerId}: ${hits}`),
    '',
  ].join('\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
