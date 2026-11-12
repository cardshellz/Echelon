import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The legacy schema fallbacks in server/db.ts (`runReleaseSchemaFallbacks`)
 * are being retired block by block (REFACTOR-PLAN-2026-07.md, P4.1). New
 * schema belongs in a tracked migration under migrations/.
 *
 * These ceilings are the size of the routine today. When you retire a block,
 * LOWER them to the new counts in the same change. Never raise them: a failing
 * test here means a statement was added to the routine, and it must move to a
 * tracked migration instead.
 */
const MAX_FALLBACK_STATEMENTS = 157;
const MAX_FALLBACK_BLOCKS = 27;

const SOURCE = readFileSync(fileURLToPath(new URL("../../db.ts", import.meta.url)), "utf8");

describe("legacy schema fallbacks only shrink (P4.1)", () => {
  const statements = SOURCE.match(/client\.query\(/g)?.length ?? 0;
  const blocks = SOURCE.match(/console\.log\(\s*["`]Checked/g)?.length ?? 0;

  it("has no more statements than the recorded ceiling", () => {
    expect(statements).toBeLessThanOrEqual(MAX_FALLBACK_STATEMENTS);
  });

  it("has no more blocks than the recorded ceiling", () => {
    expect(blocks).toBeLessThanOrEqual(MAX_FALLBACK_BLOCKS);
  });

  it("keeps the ceilings tight, so retiring a block lowers them in the same change", () => {
    expect({ statements, blocks }).toEqual({ statements: MAX_FALLBACK_STATEMENTS, blocks: MAX_FALLBACK_BLOCKS });
  });
});
