import type { Clock } from '../../shared/contracts/index.js';

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

/** A deterministic clock adapter for replay and domain tests. */
export function clockFrom(now: () => number): Clock {
  return {now, iso: () => new Date(now()).toISOString()};
}
