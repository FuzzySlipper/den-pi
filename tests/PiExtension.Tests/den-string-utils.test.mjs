/**
 * Tests for shared string and number utility functions.
 *
 * @module den-string-utils.test
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeString, oneLine, errorMessage, optionalNumber } from '../../lib/den-string-utils.ts';

// ---------------------------------------------------------------------------
// normalizeString
// ---------------------------------------------------------------------------

test('normalizeString returns undefined for non-string values', () => {
  assert.equal(normalizeString(undefined), undefined);
  assert.equal(normalizeString(null), undefined);
  assert.equal(normalizeString(42), undefined);
  assert.equal(normalizeString({}), undefined);
  assert.equal(normalizeString([]), undefined);
  assert.equal(normalizeString(true), undefined);
});

test('normalizeString returns undefined for empty/whitespace strings', () => {
  assert.equal(normalizeString(''), undefined);
  assert.equal(normalizeString('   '), undefined);
  assert.equal(normalizeString('\t\n '), undefined);
});

test('normalizeString trims and returns non-empty strings', () => {
  assert.equal(normalizeString('hello'), 'hello');
  assert.equal(normalizeString('  hello  '), 'hello');
  assert.equal(normalizeString('\thello\n'), 'hello');
  assert.equal(normalizeString('a'), 'a');
});

// ---------------------------------------------------------------------------
// oneLine
// ---------------------------------------------------------------------------

test('oneLine collapses whitespace and truncates', () => {
  assert.equal(oneLine('hello   world'), 'hello world');
  assert.equal(oneLine('a\nb\tc'), 'a b c');
  assert.equal(oneLine('x'.repeat(500), 10), 'x'.repeat(10));
  assert.equal(oneLine('  spaced  out  '), 'spaced out');
});

// ---------------------------------------------------------------------------
// errorMessage
// ---------------------------------------------------------------------------

test('errorMessage returns message for Error instances', () => {
  assert.equal(errorMessage(new Error('test error')), 'test error');
});

test('errorMessage stringifies non-Error values', () => {
  assert.equal(errorMessage('raw string'), 'raw string');
  assert.equal(errorMessage(42), '42');
  assert.equal(errorMessage(null), 'null');
  assert.equal(errorMessage(undefined), 'undefined');
});

// ---------------------------------------------------------------------------
// optionalNumber
// ---------------------------------------------------------------------------

test('optionalNumber returns the value for finite numbers', () => {
  assert.equal(optionalNumber(0), 0);
  assert.equal(optionalNumber(42), 42);
  assert.equal(optionalNumber(-1), -1);
  assert.equal(optionalNumber(3.14), 3.14);
  assert.equal(optionalNumber(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('optionalNumber returns undefined for non-number values', () => {
  assert.equal(optionalNumber(undefined), undefined);
  assert.equal(optionalNumber(null), undefined);
  assert.equal(optionalNumber('42'), undefined);
  assert.equal(optionalNumber({}), undefined);
  assert.equal(optionalNumber([]), undefined);
  assert.equal(optionalNumber(true), undefined);
});

test('optionalNumber returns undefined for non-finite values', () => {
  assert.equal(optionalNumber(Infinity), undefined);
  assert.equal(optionalNumber(-Infinity), undefined);
  assert.equal(optionalNumber(NaN), undefined);
});

test('optionalNumber handles zero and -0', () => {
  assert.equal(optionalNumber(0), 0);
  // -0 is technically different from 0 with strictEqual, so use Object.is.
  assert.ok(Object.is(optionalNumber(-0), -0), '-0 should be -0');
});
