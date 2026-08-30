import type { CircuitStateChangeEvent } from './types.js';

export type StateChangeCallback = (event: CircuitStateChangeEvent) => void;

/**
 * Extracts normalized origin from a URL string.
 */
export function extractOrigin(targetUrl: string): string {
  try {
    const parsed = new URL(targetUrl);
    return parsed.origin;
  } catch {
    return targetUrl;
  }
}
