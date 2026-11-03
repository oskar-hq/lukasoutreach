import { CancelledError } from '../pipeline/adapter.js';

/** Wartet `ms` Millisekunden – bricht sofort ab, wenn der Lauf abgebrochen wird. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CancelledError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function randomBetween(min: number, max: number, random: () => number = Math.random): number {
  return Math.round(min + (max - min) * random());
}
