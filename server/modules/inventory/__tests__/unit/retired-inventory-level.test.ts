import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isLevelDeleteForbiddenError, isRetiredEmptyLevel } from "../../domain/retired-inventory-level";

// 2026-10-02: deleting an empty STRAY row (SHLZ-MAG-100PT-C125 at H-02) returned
// a 500. Since the quantity ledger opened, the database refuses to delete any
// inventory level row, because even an empty row keeps its stock history.

const empty = { variantQty: 0, reservedQty: 0, pickedQty: 0, packedQty: 0 };

describe("isRetiredEmptyLevel", () => {
  it("hides an empty row for a bin the variant is not assigned to", () => {
    expect(isRetiredEmptyLevel(empty, false)).toBe(true);
  });

  it("keeps an assigned bin even when it is empty (a pick face awaiting stock)", () => {
    expect(isRetiredEmptyLevel(empty, true)).toBe(false);
  });

  it.each([
    ["on hand", { variantQty: 1 }],
    ["reserved", { reservedQty: 1 }],
    ["picked", { pickedQty: 1 }],
    ["packed", { packedQty: 1 }],
  ])("keeps a row with %s units", (_label, balances) => {
    expect(isRetiredEmptyLevel({ ...empty, ...balances }, false)).toBe(false);
  });
});

describe("isLevelDeleteForbiddenError", () => {
  const guard = Object.assign(new Error("QUANTITY_PROJECTION_IDENTITY_DELETE_FORBIDDEN"), { code: "23514" });

  it("recognizes the ledger guard directly or wrapped by the query layer", () => {
    expect(isLevelDeleteForbiddenError(guard)).toBe(true);
    expect(isLevelDeleteForbiddenError(Object.assign(new Error("Failed query"), { cause: guard }))).toBe(true);
  });

  it("does not hide other failures", () => {
    expect(isLevelDeleteForbiddenError(Object.assign(new Error("other check"), { code: "23514" }))).toBe(false);
    expect(isLevelDeleteForbiddenError(new Error("connection reset"))).toBe(false);
    expect(isLevelDeleteForbiddenError(null)).toBe(false);
  });
});

describe("inventory level routes", () => {
  const routes = readFileSync(resolve(process.cwd(), "server/modules/inventory/inventory.routes.ts"), "utf8");

  it("hides history-only rows from the per-variant location list", () => {
    expect(routes).toContain("!isRetiredEmptyLevel(level, assignedLocationIds.has(level.warehouseLocationId))");
  });

  it("answers the ledger's refusal with a clear 409 instead of a 500", () => {
    expect(routes).toMatch(/isLevelDeleteForbiddenError\(error\)\) \{\s*\/\/[^\n]*\n\s*return res\.status\(409\)/);
  });
});
