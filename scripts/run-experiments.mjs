import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const reportDir = path.resolve(process.env.AIMM_EXPERIMENT_REPORT_DIR ?? 'report');

async function main() {
  const testkit = await import('../packages/aimm-testkit/dist/index.js');
  const results = await testkit.runAllExperiments();
  await mkdir(reportDir, { recursive: true });

  for (const result of results) {
    const base = path.join(reportDir, result.name);
    await writeFile(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeFile(`${base}.md`, formatMarkdown(result), 'utf8');
    await writeFile(`${base}.png`, renderExperimentPng(result));
  }

  const failed = results.filter((result) => !result.pass);
  console.log(`AIMM experiments: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    for (const result of failed) {
      console.log(`FAIL ${result.name}`);
    }
    process.exitCode = 1;
  }
}

function renderExperimentPng(result) {
  const width = 640;
  const height = 360;
  const rgba = Buffer.alloc(width * height * 4, 255);
  fillRect(rgba, width, 0, 0, width, height, [250, 248, 241, 255]);
  fillRect(rgba, width, 40, 40, width - 80, height - 90, [255, 255, 255, 255]);

  const values = chartValues(result);
  const max = Math.max(...values, 1);
  const barWidth = Math.max(18, Math.floor((width - 120) / Math.max(values.length, 1)));
  values.forEach((value, index) => {
    const barHeight = Math.max(1, Math.round((value / max) * (height - 130)));
    const x = 60 + index * barWidth;
    const y = height - 50 - barHeight;
    const color = result.pass ? [31, 122, 91, 255] : [184, 65, 59, 255];
    fillRect(rgba, width, x, y, Math.max(8, barWidth - 8), barHeight, color);
  });

  // Tiny status stripe: green PASS, red FAIL. Text is in the paired .md; PNG is for report artifact presence.
  fillRect(rgba, width, 0, 0, width, 18, result.pass ? [31, 122, 91, 255] : [184, 65, 59, 255]);
  return encodePng(width, height, rgba);
}

function chartValues(result) {
  const hits = Object.values(result.result?.routingHits ?? {});
  if (hits.length > 0) return hits.map(Number);
  if (Array.isArray(result.actual)) return result.actual.map(Number);
  if (typeof result.peakU === 'number') return [result.peakU];
  if (typeof result.opusU === 'number' && typeof result.sonnetU === 'number') return [result.opusU, result.sonnetU];
  return [result.pass ? 1 : 0];
}

function fillRect(buffer, width, x, y, rectWidth, rectHeight, color) {
  for (let row = Math.max(0, y); row < Math.min(y + rectHeight, buffer.length / width / 4); row += 1) {
    for (let col = Math.max(0, x); col < Math.min(x + rectWidth, width); col += 1) {
      const offset = (row * width + col) * 4;
      buffer[offset] = color[0];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[2];
      buffer[offset + 3] = color[3];
    }
  }
}

function encodePng(width, height, rgba) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    rgba.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data]))),
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function formatMarkdown(result) {
  return [
    `# ${result.name}`,
    '',
    `Status: ${result.pass ? 'PASS' : 'FAIL'}`,
    '',
    '```json',
    JSON.stringify(result, null, 2),
    '```',
    '',
  ].join('\n');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
