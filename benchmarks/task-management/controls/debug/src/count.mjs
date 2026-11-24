export function readCount(value, fallback = 7) {
  const count = value ?? fallback;
  if (typeof count !== 'number') throw new TypeError('count');
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('count');
  return count;
}
