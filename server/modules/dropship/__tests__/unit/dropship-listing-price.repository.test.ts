import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

import { listingPriceTransactionForClient } from "../../infrastructure/dropship-listing-price.repository";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const HASH = "a".repeat(64);

/** A client that answers W9's save statements: no replay, no saved price, then the new revision's id. */
function scriptedClient() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO dropship.dropship_listing_price_revisions")) return { rows: [{ id: 31 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("W9's price save audit actor (eBay sync-back, plan v4 §1.3)", () => {
  async function save(actorType?: "vendor" | "system") {
    const client = scriptedClient();
    const tx = listingPriceTransactionForClient(client as unknown as Pick<PoolClient, "query">, { storeConnectionId: 22, productVariantId: 101, vendorId: 10,
      memberId: actorType === "system" ? "system:ebay-sync-back" : "member-1", idempotencyKey: "ebay-sync:price:7:1400:none",
      ...(actorType ? { actorType } : {}) });
    const result = await tx.save({ priceCents: 1400, pricingMode: "fixed", expectedRevisionId: null, idempotencyKey: "ebay-sync:price:7:1400:none",
      requestHash: HASH, now: NOW });
    const audit = client.calls.find((call) => call.sql.includes("'listing_price_saved',$7"));
    return { result, audit };
  }

  it("audits a system save as the system, with the revision's actor id the system's", async () => {
    const { result, audit } = await save("system");
    expect(result).toMatchObject({ idempotentReplay: false, saved: { revisionId: 31, overridePriceCents: 1400, pricingMode: "fixed" } });
    expect(audit?.params[3]).toBe("system:ebay-sync-back");
    expect(audit?.params[6]).toBe("system");
  });

  it("audits every other save as the vendor, as it always did", async () => {
    expect((await save()).audit?.params[6]).toBe("vendor");
    expect((await save("vendor")).audit?.params[6]).toBe("vendor");
  });
});
