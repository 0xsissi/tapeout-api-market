export class TimeProvider {
  constructor(private currentMs = 0) {}

  now(): number {
    return this.currentMs;
  }

  set(ms: number): void {
    this.currentMs = ms;
  }

  advance(ms: number): number {
    this.currentMs += ms;
    return this.currentMs;
  }
}
