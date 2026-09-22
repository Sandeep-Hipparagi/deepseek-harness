import assert from 'node:assert';
import {
  calculatePrice,
  calculateItemsSubtotal,
  roundCents,
  DEFAULT_DISCOUNT_TIERS
} from './dist/index.js';

console.log('=== Running Targeted Pricing Calculator Suite ===\n');

// 1. Basic calculation and rounding
console.log('Test 1: Standard calculation with discount and tax');
const items = [
  { id: '1', name: 'Widget A', price: 29.99, quantity: 2 }, // 59.98
  { id: '2', name: 'Widget B', price: 49.99, quantity: 1 }, // 49.99
]; // rawSubtotal = 109.97 -> qualifies for 5% tier (minSubtotal: 100)
const result = calculatePrice(items, { taxRate: 0.08 });
console.log('Result:', result);
assert.strictEqual(result.itemsSubtotal, 109.97);
assert.strictEqual(result.discountAmount, 5.50); // 109.97 * 0.05 = 5.4985 -> 5.50
assert.strictEqual(result.taxableSubtotal, 104.47); // 109.97 - 5.50 = 104.47
assert.strictEqual(result.taxAmount, 8.36); // 104.47 * 0.08 = 8.3576 -> 8.36
assert.strictEqual(result.grandTotal, 112.83); // 104.47 + 8.36 = 112.83
assert.strictEqual(result.itemCount, 2);
console.log('✔ PASS: Standard calculation and rounding verified.\n');

// 2. Defensive guards: null, undefined, and non-array items
console.log('Test 2: Null and undefined items guards');
const nullResult = calculatePrice(null);
assert.strictEqual(nullResult.itemsSubtotal, 0);
assert.strictEqual(nullResult.grandTotal, 0);
assert.strictEqual(nullResult.itemCount, 0);

const undefResult = calculatePrice(undefined);
assert.strictEqual(undefResult.itemsSubtotal, 0);
assert.strictEqual(undefResult.grandTotal, 0);
assert.strictEqual(undefResult.itemCount, 0);

const emptySubtotal = calculateItemsSubtotal(null);
assert.strictEqual(emptySubtotal, 0);
console.log('✔ PASS: Null and undefined guards verified.\n');

// 3. Floating-point drift avoidance: 0.1 + 0.2 precision
console.log('Test 3: Floating point precision and drift avoidance');
const driftItems = [
  { id: '1', name: 'Item 1', price: 0.10, quantity: 1 },
  { id: '2', name: 'Item 2', price: 0.20, quantity: 1 }
];
const driftSubtotal = calculateItemsSubtotal(driftItems);
assert.strictEqual(driftSubtotal, 0.30); // in standard float math 0.1 + 0.2 = 0.30000000000000004
console.log(`Subtotal 0.1 + 0.2 = ${driftSubtotal}`);
console.log('✔ PASS: Integer-cent scaling avoids IEEE 754 drift.\n');

// 4. Zero and negative quantities / prices
console.log('Test 4: Negative/malformed quantities and prices');
const malformedItems = [
  { id: '1', name: 'Item Valid', price: 10, quantity: 2 },
  { id: '2', name: 'Item Negative Price', price: -5, quantity: 2 },
  { id: '3', name: 'Item Negative Qty', price: 10, quantity: -2 },
  { id: '4', name: 'Item NaN Price', price: NaN, quantity: 2 }
];
const malformedResult = calculatePrice(malformedItems);
assert.strictEqual(malformedResult.itemsSubtotal, 20); // Only valid item price*qty = 20
assert.strictEqual(malformedResult.grandTotal, 20);
console.log('✔ PASS: Malformed and negative values sanitized safely.\n');

console.log('====================================================');
console.log('ALL TARGETED PRICING CALCULATOR TESTS PASSED 100% ✔✔');
console.log('====================================================');
