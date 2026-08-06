import { describe, expect, it, vi } from "vitest";

import {
  buildListingReplacementFailureEvidence,
  PgMarketplaceListingReplacementExecutionRepository,
} from "../../infrastructure/pg-listing-replacement-execution.repository";

describe("listing replacement failure audit evidence", () => {
  it("includes terminal error fields and exact recovery context", () => {
    const recoveryContext = { failedStepKey: "publish.create_target" };
    expect(
      buildListingReplacementFailureEvidence({
        errorCode: "FAILURE",
        errorMessage: "Provider failed.",
        recoveryContext,
        evidence: { compensationCompleted: true },
      }),
    ).toEqual({
      compensationCompleted: true,
      errorCode: "FAILURE",
      errorMessage: "Provider failed.",
      recoveryContext,
    });
  });

  it("omits recovery context when the terminal operation has none", () => {
    expect(
      buildListingReplacementFailureEvidence({
        errorCode: "PREFLIGHT_FAILED",
        errorMessage: "Preflight failed.",
        recoveryContext: null,
        evidence: { provider: "ebay" },
      }),
    ).toEqual({
      provider: "ebay",
      errorCode: "PREFLIGHT_FAILED",
      errorMessage: "Preflight failed.",
    });
  });
});

describe("PgMarketplaceListingReplacementExecutionRepository", () => {
  it("locks the listing scope before the replacement operation", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT o.*")) {
          return {
            rows: [
              {
                id: 100,
                scope_id: 10,
                owner_kind: "channel",
                provider: "ebay",
                marketplace_id: "EBAY_US",
                product_id: 33,
                channel_id: 7,
                store_connection_id: null,
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const repository = new PgMarketplaceListingReplacementExecutionRepository(
      pool as never,
      { create: () => "11111111-1111-4111-8111-111111111111" },
    );

    await expect(
      repository.claimNextStep({
        operationId: 100,
        expectedOwner: {
          kind: "channel",
          channelId: 8,
          productId: 33,
          provider: "ebay",
          marketplaceId: "EBAY_US",
        },
        actor: { type: "user", id: "admin-1" },
        leaseToken: null,
        now: new Date("2026-08-04T12:00:00.000Z"),
        leaseDurationMs: 60_000,
      }),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_OWNER_BINDING_MISMATCH",
    });

    const scopeLockIndex = queries.findIndex((sql) =>
      sql.includes("FOR UPDATE OF s"),
    );
    const operationLockIndex = queries.findIndex((sql) =>
      sql.includes("FOR UPDATE OF o"),
    );
    expect(scopeLockIndex).toBeGreaterThan(-1);
    expect(operationLockIndex).toBeGreaterThan(scopeLockIndex);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
