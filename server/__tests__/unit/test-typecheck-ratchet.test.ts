import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the test-typecheck ratchet.
 *
 * `tsconfig.tests.json` holds the exclusion list: test files that were already
 * failing when tests were first type-checked. It is debt and must only ever
 * shrink — adding an entry silences a real type error instead of fixing it, and
 * hands back the protection every unlisted file has.
 *
 * The check runs as two halves (server and client) because sources plus every
 * test file exhausts Node's default heap on a CI runner. Both halves inherit the
 * one exclusion list, and between them they must cover everything the base
 * tsconfig compiles, or a whole area could stop being checked unnoticed.
 *
 * If this fails because the count went UP, remove the entry you added and fix
 * the file. If it went DOWN, lower BASELINE — that is the ratchet working.
 */
const BASELINE_EXCLUDED_TEST_FILES = 259;

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
