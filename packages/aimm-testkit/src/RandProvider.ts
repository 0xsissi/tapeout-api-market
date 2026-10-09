export class RandProvider {
  private state: number;

  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  random(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.random() * maxExclusive);
  }

  weightedIndex(weights: number[]): number {
    const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
    if (total <= 0) return 0;
    const target = this.random() * total;
    let acc = 0;
    for (let index = 0; index < weights.length; index += 1) {
      acc += Math.max(0, weights[index] ?? 0);
      if (target <= acc) return index;
    }
    return Math.max(0, weights.length - 1);
  }
}
