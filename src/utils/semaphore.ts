export interface Permit extends Disposable {}

/**
 * Counting semaphore that limits concurrent access to a resource.
 *
 * Returns a Disposable permit so callers release automatically via `using`:
 *
 *   await using permit = await semaphore.acquire();
 *   // ... permit released at scope exit, even on throw
 */
export class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  /** Resolves once a permit is available. */
  async acquire(): Promise<Permit> {
    if (this.permits > 0) {
      this.permits--;
    } else {
      // Park until a permit is returned by another caller's dispose
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    return this.createPermit();
  }

  /** Wraps the release logic in a Disposable so `using` handles cleanup. */
  private createPermit(): Permit {
    return {
      [Symbol.dispose]: () => {
        // Wake the next waiter if any, otherwise return the permit to the pool
        const next = this.waiting.shift();
        if (next) next();
        else this.permits++;
      },
    };
  }
}
