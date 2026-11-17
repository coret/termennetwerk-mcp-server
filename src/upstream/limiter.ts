import { config } from '../config.js';

/** Spaces outgoing requests to at most `rps` per second (FIFO). */
export class RateLimiter {
  private queue: Array<() => void> = [];
  private processing = false;

  constructor(private readonly rps: number) {}

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      if (!this.processing) this.processQueue();
    });
  }

  private processQueue(): void {
    const next = this.queue.shift();
    if (!next) {
      this.processing = false;
      return;
    }
    this.processing = true;
    next();
    setTimeout(() => this.processQueue(), Math.ceil(1000 / this.rps));
  }
}

export const upstreamLimiter = new RateLimiter(config.UPSTREAM_RPS);
