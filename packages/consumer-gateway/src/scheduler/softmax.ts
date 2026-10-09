export function softmaxSample<T extends { currentPrice: number }>(
  quotes: T[],
  beta: number = 3,
): T | null {
  if (quotes.length === 0) {
    return null;
  }
  if (quotes.length === 1) {
    return quotes[0] ?? null;
  }

  const weights = quotes.map((quote) => Math.pow(1 / Math.max(quote.currentPrice, 1e-9), beta));
  const sum = weights.reduce((total, weight) => total + weight, 0);
  if (sum <= 0) {
    return quotes[0] ?? null;
  }

  const threshold = Math.random();
  let cumulative = 0;
  for (let index = 0; index < quotes.length; index++) {
    cumulative += weights[index]! / sum;
    if (threshold <= cumulative) {
      return quotes[index] ?? null;
    }
  }

  return quotes[quotes.length - 1] ?? null;
}

export function greedyPick<T extends { currentPrice: number }>(quotes: T[]): T | null {
  if (quotes.length === 0) {
    return null;
  }
  return quotes.reduce((best, quote) => {
    return quote.currentPrice < best.currentPrice ? quote : best;
  });
}
