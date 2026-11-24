export function discounted(cents, bps) {
  return cents * (10000 - bps) / 10000;
}
