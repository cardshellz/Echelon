import { describe, expect, it } from "vitest";

import { canonicalJson } from "../canonical-json";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ z: 1, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"z":1}',
    );
  });

  it("preserves array order", () => {
    expect(canonicalJson({ values: [3, 1, 2] })).not.toBe(
      canonicalJson({ values: [1, 2, 3] }),
    );
  });

  it("matches JSON omission and array-null behavior for undefined values", () => {
    expect(canonicalJson({ omitted: undefined, values: [undefined] })).toBe(
      '{"values":[null]}',
    );
  });

  it("normalizes valid dates to ISO strings", () => {
    expect(canonicalJson({ at: new Date("2026-07-14T12:00:00.000Z") })).toBe(
      '{"at":"2026-07-14T12:00:00.000Z"}',
    );
  });

  it("preserves prototype-shaped data keys in the command identity", () => {
    const value = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(canonicalJson(value)).toBe('{"__proto__":{"polluted":true}}');
    expect(canonicalJson(value)).not.toBe(canonicalJson({}));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1n])(
    "rejects non-JSON numeric value %s",
    (value) => {
      expect(() => canonicalJson({ value })).toThrow(TypeError);
    },
  );

  it("rejects circular structures", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => canonicalJson(value)).toThrow("circular");
  });
});
