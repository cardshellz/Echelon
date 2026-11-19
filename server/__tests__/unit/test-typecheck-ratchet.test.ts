import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the test-typecheck ratchet (permanently locked at 0 excluded test files).
 *
 * `tsconfig.tests.json` previously held a grandfathered exclusion list of 252
 * test files that failed when test type-checking was introduced. That debt has
 * been burned down completely to 0 (`PRs #2113, #2115` + `P2-3C`). Never add an
 * entry to `tsconfig.tests.json`: fix the type error in the test or contract.
 *
 * The check runs as two halves (server and client) because sources plus every
 * test file exhausts Node's default heap on a CI runner. Both halves inherit the
 * single shared config, and between them they must cover everything the base
 * tsconfig compiles, or a whole area could stop being checked unnoticed.
 */
const BASELINE_EXCLUDED_TEST_FILES = 0;

const LOCKED_EXCLUDED_TEST_FILES: readonly string[] = Object.freeze([]);
const LOCKED_EXCLUDED_TEST_FILES_SET = new Set<string>(LOCKED_EXCLUDED_TEST_FILES);

const FIXED_EXCLUSIONS = ["node_modules", "build", "dist"];
const HALVES = ["tsconfig.tests.server.json", "tsconfig.tests.client.json"];

/** These configs are JSON with a leading comment block, which JSON.parse rejects. */
function readConfig(name: string): { include?: string[]; exclude?: string[]; extends?: string } {
  const raw = readFileSync(join(process.cwd(), name), "utf8");
  return JSON.parse(raw.slice(raw.indexOf("{")));
}

function ratchetExclusions(): string[] {
  return (readConfig("tsconfig.tests.json").exclude ?? [])
    .filter((entry) => !FIXED_EXCLUSIONS.includes(entry));
}

describe("test typecheck ratchet", () => {
  it("permanently enforces zero excluded test files across the repository", () => {
    expect(ratchetExclusions()).toEqual([]);
    expect(readConfig("tsconfig.tests.json").exclude).toEqual(FIXED_EXCLUSIONS);
  });

  it("never grows the exclusion list", () => {
    expect(ratchetExclusions().length).toBeLessThanOrEqual(BASELINE_EXCLUDED_TEST_FILES);
  });

  it("keeps BASELINE honest so the ratchet cannot silently slacken", () => {
    expect(ratchetExclusions().length).toBe(BASELINE_EXCLUDED_TEST_FILES);
  });

  it("excludes only real test files, so no source file can hide in the list", () => {
    for (const entry of ratchetExclusions()) {
      expect(entry).toMatch(/\.test\.tsx?$/);
    }
  });

  it("locks the exact excluded test paths so no newly broken test can be swapped in", () => {
    expect(LOCKED_EXCLUDED_TEST_FILES.length).toBe(BASELINE_EXCLUDED_TEST_FILES);
    const current = ratchetExclusions();
    expect(new Set(current).size).toBe(current.length);
    const unauthorized = current.filter((entry) => !LOCKED_EXCLUDED_TEST_FILES_SET.has(entry));
    expect(unauthorized).toEqual([]);
  });

  it("covers every area the base tsconfig compiles, so no half is left unchecked", () => {
    const base = new Set(readConfig("tsconfig.json").include ?? []);
    const covered = new Set(HALVES.flatMap((half) => readConfig(half).include ?? []));
    expect(base.size).toBeGreaterThan(0);
    for (const area of base) {
      expect(covered).toContain(area);
    }
  });

  it("keeps both halves on the single shared exclusion list", () => {
    for (const half of HALVES) {
      const config = readConfig(half);
      expect(config.extends).toBe("./tsconfig.tests.json");
      // An own `exclude` would replace the inherited list rather than extend it.
      expect(config.exclude).toBeUndefined();
    }
  });
});
