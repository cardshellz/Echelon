import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * P0.2 — boot must never mutate data (source invariant / writer-ratchet seed).
 *
 * runStartupMigrations() historically carried one-time data repairs that
 * re-ran on EVERY deploy: an unledgered DELETE of inventory_levels rows, a
 * hold wipe that silently released every line-item hold on restart (audit
 * F2, CRITICAL), shipment status rewrites, engine-ref re-stamping, and a
 * recurring lot-cost "repair" that masked live cost-drift writers.
 *
 * This test freezes the boot DML surface to an explicit allowlist:
 *   - idempotent CONFIG seeds (product lines/types, sync settings default)
 *   - the fulfillment_partition_key backfill, which is load-bearing for the
 *     CHECK constraint + unique index created immediately after it
 *
 * Any new INSERT/UPDATE/DELETE in db.ts fails this test and must go through
 * a reviewed, tracked migration instead.
 */

const DB_SRC = readFileSync(
  fileURLToPath(new URL("../../db.ts", import.meta.url)),
  "utf8",
);

// Strip line comments so removed-DML explanations don't count as statements.
const CODE_ONLY = DB_SRC.split("\n")
  .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
  .join("\n");

const DML_ALLOWLIST: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /INSERT INTO catalog\.product_lines/, why: "config seed (idempotent WHERE NOT EXISTS)" },
  { pattern: /INSERT INTO catalog\.product_types/, why: "config seed (idempotent ON CONFLICT)" },
  { pattern: /INSERT INTO sync_settings/, why: "config default row (idempotent WHERE NOT EXISTS)" },
  { pattern: /UPDATE wms\.orders\s*\n?\s*SET fulfillment_partition_key = 'default'/, why: "DDL-coupled backfill required by the partition CHECK constraint + unique index" },
];

describe("db.ts boot path — no data mutations (P0.2)", () => {
  it("contains no DML outside the explicit allowlist", () => {
    const dmlMatches = CODE_ONLY.match(/(?:DELETE FROM|UPDATE|INSERT INTO)\s+[\w."]+/g) ?? [];

    const unexpected = dmlMatches.filter((stmt) => {
      // Locate the statement in context and test against the allowlist.
      const idx = CODE_ONLY.indexOf(stmt);
      const context = CODE_ONLY.slice(Math.max(0, idx - 40), idx + 120);
      return !DML_ALLOWLIST.some(({ pattern }) => pattern.test(context));
    });

    expect(
      unexpected,
      `Boot-time DML found outside the allowlist — data mutations belong in ` +
        `reviewed tracked migrations, never in runStartupMigrations():\n${unexpected.join("\n")}`,
    ).toEqual([]);
  });

  it("the hold wipe stays dead (audit F2)", () => {
    expect(CODE_ONLY).not.toMatch(/SET\s+held\s*=\s*false/i);
  });

  it("never deletes inventory rows at boot", () => {
    expect(CODE_ONLY).not.toMatch(/DELETE FROM inventory\./);
  });

  it("never rewrites shipment status, engine refs, or lot costs at boot", () => {
    expect(CODE_ONLY).not.toMatch(/UPDATE wms\.outbound_shipments/);
    expect(CODE_ONLY).not.toMatch(/UPDATE oms\.oms_orders/);
    expect(CODE_ONLY).not.toMatch(/UPDATE inventory_lots/);
    expect(CODE_ONLY).not.toMatch(/UPDATE oms\.order_item_costs/);
  });
});
