export function gini(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (sorted.length === 0 || total === 0) return 0;
  const weighted = sorted.reduce((sum, value, index) => sum + (index + 1) * value, 0);
  return (2 * weighted) / (sorted.length * total) - (sorted.length + 1) / sorted.length;
}

export function maxDeviationPercent(actual: number[], expected: number[]): number {
  return actual.reduce((max, value, index) => {
    const baseline = Math.max(Math.abs(expected[index] ?? 0), 1e-9);
    return Math.max(max, Math.abs(value - (expected[index] ?? 0)) / baseline);
  }, 0);
}
