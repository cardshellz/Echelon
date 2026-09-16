import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the test-typecheck ratchet (tsconfig.tests.json).
 *
 * The exclusion list is debt recorded when test files were first type-checked.
 * It must only ever shrink: adding an entry silences a real type error instead
 * of fixing it, and hands back the protection every unlisted file has. If this
 * test fails because the count went UP, remove the entry you added and fix the
 * file. If it fails because the count went DOWN, lower BASELINE — that is the
 * ratchet working.
 */
const BASELINE_EXCLUDED_TEST_FILES = 259;

const FIXED_EXCLUSIONS = ["node_modules", "build", "dist"];

function readRatchetExclusions(): string[] {
  const raw = readFileSync(join(process.cwd(), "tsconfig.tests.json"), "utf8");
  // The file is JSON with a leading comment block, which JSON.parse rejects.
  const config = JSON.parse(raw.slice(raw.indexOf("{"))) as { exclude?: string[] };
  const exclude = config.exclude ?? [];
  return exclude.filter((entry) => !FIXED_EXCLUSIONS.includes(entry));
}

describe("test typecheck ratchet", () => {
  it("never grows the exclusion list", () => {
    expect(readRatchetExclusions().length).toBeLessThanOrEqual(BASELINE_EXCLUDED_TEST_FILES);
  });

  it("keeps BASELINE honest so the ratchet cannot silently slacken", () => {
    expect(readRatchetExclusions().length).toBe(BASELINE_EXCLUDED_TEST_FILES);
  });

  it("excludes only real test files, so no source file can hide in the list", () => {
    for (const entry of readRatchetExclusions()) {
      expect(entry).toMatch(/\.test\.tsx?$/);
    }
  });
});
