import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  PgDropshipSelectionAtpRepository,
  SELECTION_RULES_RETIRED_DB_MESSAGE,
  selectionRulesRetiredOr,
} from "../../infrastructure/dropship-selection-atp.repository";
import { statusForDropshipVendorCatalogError } from "../../interfaces/http/dropship-vendor-catalog.routes";

/**
 * Step 1 plan S2-5 §4.9 item 2 (D39): PR B's freeze trigger raises exactly
 * `RAISE EXCEPTION 'DROPSHIP_SELECTION_RULES_RETIRED' USING ERRCODE = 'P0001'`.
 * A's rules save answers exactly that as 410 "page was updated, reload", and
 * nothing else changes: another P0001, or the same words with another code,
 * keeps today's answer.
 */
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository", () => ({
  createAuthorityAwareInventoryAtpService: () => ({}),
}));

const NOW = new Date("2026-10-20T12:00:00.000Z");

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** A client that answers the save's statements and raises `raise` at the first write to the rules table. */
function scriptedPool(raise: unknown) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql.trim().split(/\s+/).slice(0, 4).join(" "));
    if (sql.includes("FROM dropship.dropship_vendor_selection_rule_set_revisions") && sql.includes("FOR UPDATE")) return { rows: [] };
    if (sql.includes("INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions")) return { rows: [{ id: 91 }] };
    if (sql.includes("UPDATE dropship.dropship_vendor_selection_rules")) throw raise;
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client, statements, query };
}

function save(pool: Pool) {
  return new PgDropshipSelectionAtpRepository(pool).replaceSelectionRules({
    vendorId: 10, idempotencyKey: "save-after-freeze", requestHash: "a".repeat(64),
    actor: { actorType: "vendor", actorId: "member-10" }, rules: [], now: NOW,
  });
}

describe("the rules save answers B's freeze (S2-5 §4.9 item 2)", () => {
  it("fixes B's trigger message as the contract", () => {
    expect(SELECTION_RULES_RETIRED_DB_MESSAGE).toBe("DROPSHIP_SELECTION_RULES_RETIRED");
  });

  it("maps exactly P0001 with exactly that message to the retired refusal, rolled back, answered 410", async () => {
    const { pool, client, statements } = scriptedPool(pgError("P0001", "DROPSHIP_SELECTION_RULES_RETIRED"));

    const error = await save(pool).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(DropshipError);
    expect(error).toMatchObject({
      code: "DROPSHIP_SELECTION_RULES_RETIRED",
      message: "This page was updated, so your last changes weren't saved. Reload it and make them again.",
      context: { retryable: false, classification: "permanent" },
    });
    expect(statusForDropshipVendorCatalogError("DROPSHIP_SELECTION_RULES_RETIRED")).toBe(410);
    // The revision row it inserted goes with the rollback; the client goes back to the pool.
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another P0001 message", pgError("P0001", "SOMETHING_ELSE_RETIRED")],
    ["the words with another SQLSTATE", pgError("23514", "DROPSHIP_SELECTION_RULES_RETIRED")],
    ["the words with extra text", pgError("P0001", "DROPSHIP_SELECTION_RULES_RETIRED: frozen")],
    ["a lock timeout", pgError("55P03", "canceling statement due to lock timeout")],
  ])("keeps today's answer for %s", async (_label, raised) => {
    const { pool, statements } = scriptedPool(raised);

    await expect(save(pool)).rejects.toBe(raised);
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it("passes non-error values and plain errors through unchanged", () => {
    const plain = new Error("DROPSHIP_SELECTION_RULES_RETIRED");
    expect(selectionRulesRetiredOr(plain)).toBe(plain);
    expect(selectionRulesRetiredOr(null)).toBeNull();
    expect(selectionRulesRetiredOr("P0001")).toBe("P0001");
  });
});
