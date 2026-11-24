export function discounted(cents, bps) {
  if (typeof cents !== 'number' || typeof bps !== 'number') throw new TypeError('amount');
  if (!Number.isSafeInteger(cents) || cents < 0 || !Number.isSafeInteger(bps) || bps < 0 || bps > 10000) throw new RangeError('amount');
  return Number((BigInt(cents) * (10000n - BigInt(bps)) + 5000n) / 10000n);
}
