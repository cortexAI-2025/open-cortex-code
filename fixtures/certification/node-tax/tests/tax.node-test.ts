import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tax } from '../src/tax.ts';

test('taxe 20 pour cent', () => {
  assert.equal(tax(100), 20);
});
