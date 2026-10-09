export interface CircuitBreakerStateChange {
  opened: boolean;
  closed: boolean;
  isOpen: boolean;
}

export class CircuitBreaker {
  private highUtilStartAt: number | null = null;
  private open = false;

  constructor(
    private readonly options: {
      openThreshold?: number;
      closeThreshold?: number;
      sustainMs?: number;
    } = {},
  ) {}

  get isOpen(): boolean {
    return this.open;
  }

  tick(utilization: number, now = Date.now()): CircuitBreakerStateChange {
    const openThreshold = this.options.openThreshold ?? 0.95;
    const closeThreshold = this.options.closeThreshold ?? 0.9;
    const sustainMs = this.options.sustainMs ?? 60_000;

    if (this.open) {
      if (utilization < closeThreshold) {
        this.open = false;
        this.highUtilStartAt = null;
        return { opened: false, closed: true, isOpen: false };
      }
      return { opened: false, closed: false, isOpen: true };
    }

    if (utilization >= openThreshold) {
      this.highUtilStartAt ??= now;
      if (now - this.highUtilStartAt >= sustainMs) {
        this.open = true;
        return { opened: true, closed: false, isOpen: true };
      }
      return { opened: false, closed: false, isOpen: false };
    }

    this.highUtilStartAt = null;
    return { opened: false, closed: false, isOpen: false };
  }
}
