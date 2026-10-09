import { EventEmitter } from 'node:events';

export class UtilizationTracker extends EventEmitter {
  private inFlight = 0;
  private readonly maxConcurrent: number;
  private lastBroadcastUtilization = 0;
  private readonly jumpThreshold: number;

  constructor(maxConcurrent: number, jumpThreshold = 0.15) {
    super();
    this.maxConcurrent = maxConcurrent;
    this.jumpThreshold = jumpThreshold;
  }

  onRequestStart(): void {
    this.inFlight++;
    this.maybeEmitJump();
  }

  onRequestEnd(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.maybeEmitJump();
  }

  get current(): number {
    if (this.maxConcurrent <= 0) {
      return 0.999;
    }
    return Math.min(this.inFlight / this.maxConcurrent, 0.999);
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  private maybeEmitJump(): void {
    const current = this.current;
    if (Math.abs(current - this.lastBroadcastUtilization) < this.jumpThreshold) {
      return;
    }

    const previous = this.lastBroadcastUtilization;
    this.lastBroadcastUtilization = current;
    this.emit('u-jump', {
      from: previous,
      to: current,
      inFlight: this.inFlight,
    });
  }
}
