const beta = Number(process.env.AIMM_SOFTMAX_BETA ?? '3');
const p0 = Number(process.env.AIMM_P0 ?? '2');
const alpha = Number(process.env.AIMM_ALPHA ?? '1');
const samples = Number(process.env.AIMM_SIM_SAMPLES ?? '1000');
const utilizations = parseNumberList(process.env.AIMM_UTILIZATIONS ?? '0,0.25,0.5,0.75,0.9');

const quotes = utilizations.map((utilization, index) => ({
  makerId: `maker-${index + 1}`,
  utilization,
  currentPrice: cucPrice(p0, utilization, alpha),
}));

const counts = new Map(quotes.map((quote) => [quote.makerId, 0]));
for (let i = 0; i < samples; i += 1) {
  const picked = softmaxSample(quotes, beta);
  counts.set(picked.makerId, (counts.get(picked.makerId) ?? 0) + 1);
}

console.log(`AIMM CUC simulation | p0=${p0} alpha=${alpha} beta=${beta} samples=${samples}`);
for (const quote of quotes) {
  const count = counts.get(quote.makerId) ?? 0;
  console.log(
    `${quote.makerId} | u=${quote.utilization.toFixed(2)} | price=$${quote.currentPrice.toFixed(2)} | pick-rate=${(count / samples * 100).toFixed(1)}%`,
  );
}

function cucPrice(basePrice, utilization, curveAlpha) {
  const u = Math.min(Math.max(utilization, 0), 0.999);
  return basePrice / ((1 - u) ** curveAlpha);
}

function softmaxSample(quotesList, currentBeta) {
  const weights = quotesList.map((quote) => (1 / quote.currentPrice) ** currentBeta);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const threshold = Math.random() * total;
  let cursor = 0;
  for (let index = 0; index < quotesList.length; index += 1) {
    cursor += weights[index];
    if (threshold <= cursor) {
      return quotesList[index];
    }
  }
  return quotesList[quotesList.length - 1];
}

function parseNumberList(raw) {
  return raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
}
