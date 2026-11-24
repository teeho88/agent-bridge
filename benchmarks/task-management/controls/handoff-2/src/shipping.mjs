export function shippingFee(quote, policy) {
  const values = [quote.subtotal, quote.itemDiscountTotal, quote.orderDiscountTotal, policy.freeThreshold, policy.fee];
  if (values.some(value => typeof value !== 'number')) throw new TypeError('amount');
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new RangeError('amount');
  if (BigInt(quote.itemDiscountTotal) + BigInt(quote.orderDiscountTotal) > BigInt(quote.subtotal)) throw new RangeError('discount');
  return quote.subtotal - quote.itemDiscountTotal - quote.orderDiscountTotal >= policy.freeThreshold ? 0 : policy.fee;
}
