/**
 * Unit tests for the single-source-of-truth min-input gate exported from
 * suggestion-store.ts. Pure function, no host or history dependencies.
 *
 * Run: bun test/test/passes-min-input.test.ts
 */

import { test, expect } from "bun:test"
import { passesMinInput } from "../src/suggestion-store"

test("passesMinInput: two CJK graphemes beat a threshold of 3", () => {
  expect(passesMinInput("你好", 3)).toBe(true)
})

test("passesMinInput: two ASCII chars fail a threshold of 3", () => {
  expect(passesMinInput("ab", 3)).toBe(false)
})

test("passesMinInput: three ASCII chars pass a threshold of 3", () => {
  expect(passesMinInput("abc", 3)).toBe(true)
})

test("passesMinInput: empty input fails", () => {
  expect(passesMinInput("", 3)).toBe(false)
})