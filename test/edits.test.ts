import test from 'node:test';
import assert from 'node:assert/strict';
import { canRevert, inverse, receiptFor, isAutoEligible } from '../core/edits.js';
import { configSchema } from '../core/config.js';

test('Backspace restores the full prefix without deleting the user typing before it', () => {
  const before = '😀 function f() { ret';
  const start = before.indexOf('ret');
  const receipt = receiptFor('file:///code.ts', 8, before, { start, end: before.length, text: 'return' });
  const after = before.slice(0, start) + 'return';
  assert.ok(canRevert(receipt, receipt.uri, 8, after, after.length));
  const undo = inverse(receipt);
  assert.equal(after.slice(0, undo.start) + undo.text + after.slice(undo.end), before);
  assert.equal(canRevert(receipt, receipt.uri, 9, after, after.length), false);
  assert.equal(canRevert(receipt, receipt.uri, 8, after, after.length - 1), false);
  assert.equal(canRevert(receipt, 'file:///other.ts', 8, after, after.length), false);
  assert.equal(canRevert(receipt, receipt.uri, 8, after.replace('return', 'retire'), after.length), false);
});

test('automatic insertion requires a strong lead, allowed kind, prefix, and bounded single line', () => {
  const config = configSchema.parse({}).auto;
  assert.equal(isAutoEligible('Keyword', 'return', 'ret', 0.98, 0.2, config), true);
  assert.equal(isAutoEligible('Keyword', 'return', 'ret', 0.98, 0.9, config), false);
  assert.equal(isAutoEligible('Keyword', 'return', 'ret', undefined, undefined, config), false);
  assert.equal(isAutoEligible('Function', 'return', 'ret', 0.99, 0.1, config), false);
  assert.equal(isAutoEligible('Keyword', 'return', 'r', 0.99, 0.1, config), false);
  assert.equal(isAutoEligible('Keyword', 'return\n', 'ret', 0.99, 0.1, config), false);
  assert.equal(isAutoEligible('Keyword', 'throw', 'ret', 0.99, 0.1, config), false);
});
