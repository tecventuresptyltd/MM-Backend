import { SeededRNG } from "../../src/race/lib/random.js";

export const withDeterministicRng = async <T>(
  seed: number | string,
  fn: () => Promise<T>,
): Promise<T> => {
  const originalRandom = Math.random;
  const rng = new SeededRNG(seed);
  Math.random = () => rng.next();
  try {
    return await fn();
  } finally {
    Math.random = originalRandom;
  }
};

export const withDeterministicRngSync = <T>(
  seed: number | string,
  fn: () => T,
): T => {
  const originalRandom = Math.random;
  const rng = new SeededRNG(seed);
  Math.random = () => rng.next();
  try {
    return fn();
  } finally {
    Math.random = originalRandom;
  }
};
