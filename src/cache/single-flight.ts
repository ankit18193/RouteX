/**
 * SingleFlightGroup suppresses duplicate in-flight executions for identical keys.
 * Concurrent callers for the same key share the same Promise result or error.
 */
export class SingleFlightGroup {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  /**
   * Execute a function or join an existing in-flight execution for the specified key.
   */
  public execute<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Get the current count of in-flight promises.
   */
  public get size(): number {
    return this.inFlight.size;
  }

  /**
   * Clear all tracked in-flight entries.
   */
  public clear(): void {
    this.inFlight.clear();
  }
}
