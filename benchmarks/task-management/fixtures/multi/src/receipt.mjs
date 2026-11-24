import { discounted } from './amount.mjs';
export function receipt(cents, bps) {
  return { cents: discounted(cents, bps), text: 'USD ' + discounted(cents, bps) / 100 };
}
