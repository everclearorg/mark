/**
 * Runtime polyfills that are safe to load before any dependencies.
 * Ensures Array.prototype.toReversed exists for environments missing ES2023 helpers.
 */
declare global {
  interface Array<T> {
    toReversed(): T[];
  }
}

if (!Array.prototype.toReversed) {
  Object.defineProperty(Array.prototype, 'toReversed', {
    value: function toReversed<T>(this: T[]) {
      // Return a shallow copy reversed without mutating the original array.
      return [...this].reverse();
    },
    writable: true,
    configurable: true,
  });
}

export {}
