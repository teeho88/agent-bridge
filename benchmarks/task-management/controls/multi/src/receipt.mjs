import { discounted } from './amount.mjs';
export function receipt(cents, bps) {
  const amount = discounted(cents, bps), integer = BigInt(amount);
  return { cents: amount, text: 'USD ' + integer / 100n + '.' + String(integer % 100n).padStart(2, '0') };
}
