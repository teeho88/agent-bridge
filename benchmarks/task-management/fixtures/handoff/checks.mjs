import test from 'node:test';
import assert from 'node:assert/strict';
import { shippingFee } from './src/shipping.mjs';
export function checks({ freeAt, feeAt80 }) {
  test('current shipping rule, equality and immutable inputs', () => {
    const quote = Object.freeze({ subtotal: 100, itemDiscountTotal: 10, orderDiscountTotal: 20 });
    assert.equal(shippingFee(quote, Object.freeze({ freeThreshold: 80, fee: 9 })), feeAt80);
    assert.equal(shippingFee(quote, { freeThreshold: freeAt, fee: 9 }), 0);
    assert.equal(shippingFee(quote, { freeThreshold: 101, fee: 9 }), 9);
  });
  test('validation remains unchanged', () => {
    const quote = { subtotal: 100, itemDiscountTotal: 10, orderDiscountTotal: 20 };
    assert.throws(() => shippingFee({ ...quote, subtotal: '100' }, { freeThreshold: 1, fee: 9 }), TypeError);
    assert.throws(() => shippingFee({ ...quote, orderDiscountTotal: 91 }, { freeThreshold: 1, fee: 9 }), RangeError);
    assert.throws(() => shippingFee(quote, { freeThreshold: 1, fee: -1 }), RangeError);
    assert.throws(() => shippingFee(quote, { freeThreshold: Infinity, fee: 0 }), RangeError);
  });
}
