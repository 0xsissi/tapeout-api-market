import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sellerUrl = normalizeUrl(process.env.AIMM_SMOKE_SELLER_URL ?? 'http://127.0.0.1:8787');
const buyerUrl = normalizeUrl(process.env.AIMM_SMOKE_BUYER_URL ?? 'http://127.0.0.1:18080');
const model = process.env.AIMM_SMOKE_MODEL ?? 'gpt-5.4';
const requestCount = Number(process.env.AIMM_SMOKE_REQUESTS ?? '5');
const reportDir = path.resolve(process.env.AIMM_SMOKE_REPORT_DIR ?? 'report');

async function main() {
  const sellerStatus = await fetchJson(`${sellerUrl}/v1/seller/status`);
  const sellerMetrics = await fetchText(`${sellerUrl}/metrics`);
  const buyerMetricsBefore = await fetchText(`${buyerUrl}/metrics`).catch(() => '');

  const responses = [];
  let failure = null;
  for (let index = 0; index < requestCount; index += 1) {
    const res = await fetch(`${buyerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `AIMM smoke request ${index + 1}: answer with exactly ok.` }],
        max_tokens: 8,
      }),
    });
    const body = await res.text();
    responses.push({ ok: res.ok, status: res.status, body });
    if (!res.ok) {
      failure = {
        requestIndex: index + 1,
        status: res.status,
        body,
      };
      break;
    }
  }

  const buyerMetricsAfter = await fetchText(`${buyerUrl}/metrics`).catch(() => '');
  const summary = {
    pass: failure == null && responses.length === requestCount,
    seller: {
      walletAddress: sellerStatus?.seller?.walletAddress,
      models: sellerStatus?.backend?.models?.map?.((item) => item.model) ?? [],
      metricsPresent: sellerMetrics.includes('aimm_quotes_broadcast_total'),
    },
    buyer: {
      metricsBefore: parseMetric(buyerMetricsBefore, 'aimm_requests_outbound_total'),
      metricsAfter: parseMetric(buyerMetricsAfter, 'aimm_requests_outbound_total'),
    },
    requestCount,
    completedRequests: responses.filter((response) => response.ok).length,
    failure,
    responses: responses.map((response) => ({ ok: response.ok, status: response.status, bytes: response.body.length })),
  };

  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `e2e-smoke-${yyyymmdd()}.md`);
  await writeFile(reportPath, formatSmokeMarkdown(summary), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.pass) {
    process.exitCode = 1;
  }
}

function normalizeUrl(value) {
  return value.replace(/\/+$/, '');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return await res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return await res.text();
}

function parseMetric(text, name) {
  return text
    .split('\n')
    .filter((line) => line.startsWith(name))
    .map((line) => line.trim());
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

function formatSmokeMarkdown(summary) {
  return [
    `# AIMM E2E Smoke ${yyyymmdd()}`,
    '',
    `Status: ${summary.pass ? 'PASS' : 'FAIL'}`,
    '',
    `Seller wallet: ${summary.seller.walletAddress ?? 'unknown'}`,
    `Models: ${summary.seller.models.join(', ') || 'none'}`,
    `Seller metrics present: ${summary.seller.metricsPresent ? 'yes' : 'no'}`,
    `Completed requests: ${summary.completedRequests}/${summary.requestCount}`,
    '',
    ...(summary.failure
      ? [
          '## Failure',
          '',
          `- Request: ${summary.failure.requestIndex}`,
          `- HTTP: ${summary.failure.status}`,
          `- Body: ${summary.failure.body}`,
          '',
        ]
      : []),
    '## Responses',
    '',
    ...summary.responses.map((response, index) => `- Request ${index + 1}: ${response.ok ? 'OK' : 'FAIL'} HTTP ${response.status}, ${response.bytes} bytes`),
    '',
  ].join('\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
