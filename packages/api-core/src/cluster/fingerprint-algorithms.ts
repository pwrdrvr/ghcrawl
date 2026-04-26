import crypto from 'node:crypto';

const MASK_64 = (1n << 64n) - 1n;

function stableHash64(value: string, seed = 0): bigint {
  const digest = crypto.createHash('sha256').update(`${seed}:${value}`).digest();
  return digest.readBigUInt64BE(0);
}

export function buildShingles(tokens: string[], size = 3): string[] {
  const normalizedSize = Math.max(1, Math.trunc(size));
  if (tokens.length === 0) return [];
  if (tokens.length < normalizedSize) return [tokens.join(' ')];
  const shingles: string[] = [];
  for (let index = 0; index <= tokens.length - normalizedSize; index += 1) {
    shingles.push(tokens.slice(index, index + normalizedSize).join(' '));
  }
  return Array.from(new Set(shingles));
}

export function minhashSignature(tokens: string[], params: { permutations?: number; shingleSize?: number } = {}): string[] {
  const permutations = Math.max(1, Math.trunc(params.permutations ?? 64));
  const shingles = buildShingles(tokens, params.shingleSize ?? 3);
  if (shingles.length === 0) {
    return Array.from({ length: permutations }, () => '0');
  }

  const signature: string[] = [];
  for (let seed = 0; seed < permutations; seed += 1) {
    let minValue: bigint | null = null;
    for (const shingle of shingles) {
      const value = stableHash64(shingle, seed);
      if (minValue === null || value < minValue) {
        minValue = value;
      }
    }
    signature.push((minValue ?? 0n).toString(16).padStart(16, '0'));
  }
  return signature;
}

export function minhashSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let matches = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) matches += 1;
  }
  return matches / left.length;
}

export function simhash64(tokens: string[]): string {
  const weights = Array.from({ length: 64 }, () => 0);
  for (const token of tokens) {
    const hash = stableHash64(token) & MASK_64;
    for (let bit = 0; bit < 64; bit += 1) {
      weights[bit] += ((hash >> BigInt(bit)) & 1n) === 1n ? 1 : -1;
    }
  }

  let value = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (weights[bit] >= 0) {
      value |= 1n << BigInt(bit);
    }
  }
  return value.toString(16).padStart(16, '0');
}

export function simhashSimilarity(leftHex: string, rightHex: string): number {
  const left = BigInt(`0x${leftHex}`);
  const right = BigInt(`0x${rightHex}`);
  let value = left ^ right;
  let distance = 0;
  while (value > 0n) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return Math.max(0, 1 - distance / 64);
}

export function winnowingFingerprints(tokens: string[], params: { kgram?: number; window?: number } = {}): string[] {
  const kgram = Math.max(1, Math.trunc(params.kgram ?? 5));
  const window = Math.max(1, Math.trunc(params.window ?? 4));
  const grams = buildShingles(tokens, kgram);
  if (grams.length === 0) return [];
  const hashes = grams.map((gram) => stableHash64(gram).toString(16).padStart(16, '0'));
  if (hashes.length <= window) {
    return [hashes.reduce((min, value) => (value < min ? value : min), hashes[0])];
  }

  const selected = new Set<string>();
  for (let start = 0; start <= hashes.length - window; start += 1) {
    const slice = hashes.slice(start, start + window);
    selected.add(slice.reduce((min, value) => (value < min ? value : min), slice[0]));
  }
  return Array.from(selected).sort();
}

export function jaccard<T>(left: Set<T>, right: Set<T>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
