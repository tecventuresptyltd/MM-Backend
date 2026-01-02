const MODULUS = 0x100000000; // 2^32
const MULTIPLIER = 1664525;
const INCREMENT = 1013904223;

const normalizeSeed = (seed: number | string | undefined): number => {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return (seed >>> 0) || 1;
  }
  if (typeof seed === "string") {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return hash || 1;
  }
  return (Date.now() >>> 0) || 1;
};

const clampIntRange = (min: number, max: number): [number, number] => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 0];
  }
  return min <= max ? [Math.floor(min), Math.floor(max)] : [Math.floor(max), Math.floor(min)];
};

export class SeededRNG {
  private state: number;

  constructor(seed: number | string = Date.now()) {
    this.state = normalizeSeed(seed);
  }

  private advance(): number {
    this.state = (MULTIPLIER * this.state + INCREMENT) >>> 0;
    return this.state;
  }

  next(): number {
    return this.advance() / MODULUS;
  }

  nextFloat(min = 0, max = 1): number {
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 1;
    if (hi === lo) {
      return lo;
    }
    const [start, end] = hi > lo ? [lo, hi] : [hi, lo];
    return start + this.next() * (end - start);
  }

  nextInt(min: number, max: number): number {
    const [lo, hi] = clampIntRange(min, max);
    if (lo === hi) {
      return lo;
    }
    const range = hi - lo + 1;
    return lo + Math.floor(this.next() * range);
  }

  choice<T>(array: T[]): T | undefined {
    if (!Array.isArray(array) || array.length === 0) {
      return undefined;
    }
    const idx = this.nextInt(0, array.length - 1);
    return array[idx];
  }

  shuffle<T>(array: T[]): T[] {
    const clone = Array.isArray(array) ? [...array] : [];
    for (let i = clone.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(0, i);
      const tmp = clone[i];
      clone[i] = clone[j];
      clone[j] = tmp;
    }
    return clone;
  }

  float(min: number, max: number): number {
    return this.nextFloat(min, max);
  }

  /**
   * Generate random number from normal distribution using Box-Muller transform
   * @param mean - Mean (center) of the distribution
   * @param stdDev - Standard deviation (spread) of the distribution
   */
  normal(mean: number = 0, stdDev: number = 1): number {
    // Box-Muller transform: generates normally distributed values from uniform random values
    const u1 = this.next();
    const u2 = this.next();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z0 * stdDev;
  }

  int(min: number, max: number): number {
    return this.nextInt(min, max);
  }
}
