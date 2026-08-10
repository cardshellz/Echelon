import { describe, expect, it, vi } from "vitest";

import {
  buildListingReplacementFailureEvidence,
  claimStateForStep,
  buildListingReplacementStepEventEvidence,
  PgMarketplaceListingReplacementExecutionRepository,
} from "../../infrastructure/pg-listing-replacement-execution.repository";

describe("listing replacement claim state", () => {
  it("validates compensation completions against compensating state", () => {
    expect(claimStateForStep("compensate.ensure_target_not_sellable")).toEqual({
      status: "compensating",
      phase: "compensate",
    });
  });

  it("keeps forward completions in their deterministic phase", () => {
    expect(claimStateForStep("publish.create_target")).toEqual({
      status: "running",
      phase: "publish",
    });
  });
});
describe("listing replacement step audit evidence", () => {
  it("preserves exact error fields for failed steps", () => {
    expect(
      buildListingReplacementStepEventEvidence(
        {
          status: "failed",
          error_code: "MARKETPLACE_LISTING_REPLACEMENT_LEASE_EXPIRED",
          error_message: "The previous executor lease expired.",
          result_evidence: null,
        },
        { recoveredExpiredLease: true },
      ),
    ).toEqual({
      recoveredExpiredLease: true,
      errorCode: "MARKETPLACE_LISTING_REPLACEMENT_LEASE_EXPIRED",
      errorMessage: "The previous executor lease expired.",
    });
  });

  it("preserves exact result evidence for succeeded steps", () => {
    const resultEvidence = { sourceListingId: "source-listing" };
    expect(
      buildListingReplacementStepEventEvidence(
        {
          status: "succeeded",
          error_code: null,
          error_message: null,
          result_evidence: resultEvidence,
        },
        resultEvidence,
      ),
    ).toEqual({
      sourceListingId: "source-listing",
      resultEvidence,
    });
  });
});
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
  it("records an explicit decision before resuming manual compensation", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const operation = {
      id: 100,
      scope_id: 10,
      source_publication_id: 51,
      target_publication_id: 52,
      status: "manual_recovery_required",
      current_phase: "compensate",
      state_version: 2,
      attempt_count: 1,
      attempt_limit: 3,
      lease_token: null,
      lease_expires_at: null,
      requested_by_type: "user",
      requested_by_id: "admin-1",
      correlation_id: null,
      desired_state_hash: "a".repeat(64),
      recovery_context: { failedStepKey: "compensate.ensure_source_live" },
      owner_kind: "channel",
      provider: "ebay",
      marketplace_id: "EBAY_US",
      product_id: 33,
      channel_id: 7,
      store_connection_id: null,
      source_generation: 1,
      source_desired_state_hash: "b".repeat(64),
      source_provider_publication_key: "ARM-ENV-SGL",
      source_external_listing_id: "old-listing",
      target_generation: 2,
      target_provider_publication_key: null,
      target_external_listing_id: null,
    };
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes("SELECT o.*")) return { rows: [operation] };
        if (sql.includes("UPDATE marketplace.listing_replacement_operations")) {
          return {
            rows: [
              {
                ...operation,
                status: "compensating",
                state_version: 3,
                attempt_count: 2,
                lease_token: "11111111-1111-4111-8111-111111111111",
                lease_expires_at: new Date("2026-08-07T12:05:00Z"),
                completed_at: null,
                error_code: null,
                error_message: null,
              },
            ],
          };
        }
        if (sql.includes("SELECT COALESCE(MAX(sequence)")) {
          return { rows: [{ next_sequence: 8 }] };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const repository = new PgMarketplaceListingReplacementExecutionRepository({
      connect: vi.fn(async () => client),
    } as never);

    await expect(
      repository.claimNextStep({
        operationId: 100,
        expectedOwner: {
          kind: "channel",
          channelId: 7,
          productId: 33,
          provider: "ebay",
          marketplaceId: "EBAY_US",
        },
        actor: { type: "user", id: "admin-1" },
        leaseToken: null,
        now: new Date("2026-08-07T12:00:00Z"),
        leaseDurationMs: 300_000,
        recoveryAuthorized: true,
      }),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_NEXT_STEP_NOT_FOUND",
    });

    const transition = queries.find(({ sql }) =>
      sql.includes("UPDATE marketplace.listing_replacement_operations"),
    );
    expect(transition?.values[1]).toBe("compensating");
    expect(transition?.values[3]).toEqual(expect.any(String));
    expect(transition?.values[7]).toBe(true);
    expect(transition?.sql).toContain(
      "completed_at = CASE WHEN $8 THEN NULL",
    );
    const event = queries.find(({ sql }) =>
      sql.includes("INSERT INTO marketplace.listing_replacement_events"),
    );
    expect(JSON.stringify(event?.values)).toContain("retry_compensation");
    expect(client.release).toHaveBeenCalledOnce();
  });
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
