import { describe, expect, it, vi } from "vitest";
import {
  claimVariantAvailabilitySyncs,
  enqueueVariantAvailabilitySync,
  markVariantAvailabilityDelegated,
  markVariantAvailabilityFailed,
  markVariantAvailabilityNotApplicable,
  type ClaimedVariantAvailabilitySync,
  type SqlClient,
  type SqlPool,
} from "../../variant-availability-sync.repository";

const CLAIM: ClaimedVariantAvailabilitySync = {
  channelId: 67,
  productVariantId: 67,
  desiredActive: false,
  revision: 9,
  attemptCount: 99,
  leaseToken: "00000000-0000-4000-8000-000000000001",
  requestKind: "stock_repair",
};

describe("variant availability sync repository", () => {
  it("atomically enqueues the requested desired state", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const pool = { query } as unknown as SqlPool;

    await expect(enqueueVariantAvailabilitySync(pool, {
      channelId: 67,
      productVariantId: 438,
      desiredActive: false,
      requestKind: "stock_repair",
    })).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toBe("SELECT channels.request_variant_availability_refresh($1,$2,$3,$4)");
    expect(query.mock.calls[0][1]).toEqual([67, 438, false, "stock_repair"]);
  });

  it("rejects invalid enqueue identifiers before writing", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as SqlPool;

    await expect(enqueueVariantAvailabilitySync(pool, {
      channelId: 0,
      productVariantId: 438,
      desiredActive: false,
      requestKind: "stock_repair",
    })).rejects.toThrow("channelId must be a positive safe integer");
    expect(query).not.toHaveBeenCalled();
  });

  it("claims due work with a transaction, lease, and SKIP LOCKED", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [{ promoted: 0 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          channel_id: 67,
          product_variant_id: 67,
          desired_active: false,
          revision: "9",
          attempt_count: 2,
          lease_token: "00000000-0000-4000-8000-000000000002",
          request_kind: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    const release = vi.fn();
    const client = { query, release } as unknown as SqlClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as SqlPool;

    await expect(claimVariantAvailabilitySyncs(pool, {
      batchSize: 10,
      leaseSeconds: 120,
    })).resolves.toEqual([{
      channelId: 67,
      productVariantId: 67,
      desiredActive: false,
      revision: 9,
      attemptCount: 2,
      leaseToken: "00000000-0000-4000-8000-000000000002",
      requestKind: null,
    }]);

    expect(query.mock.calls[0][0]).toBe("BEGIN");
    expect(query.mock.calls[1][0]).toContain("promote_completed_availability_followups");
    expect(query.mock.calls[1][1]).toEqual([10]);
    expect(query.mock.calls[2][0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.mock.calls[2][0]).toContain("lease_expires_at");
    expect(query.mock.calls[3][0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps failed safety updates retryable with a capped 30-minute delay", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const pool = { query } as unknown as SqlPool;

    await expect(markVariantAvailabilityFailed(
      pool,
      CLAIM,
      new Error("temporary eBay failure"),
    )).resolves.toBe("retryable");

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain("SET status = 'retryable'");
    expect(query.mock.calls[0][1]).toEqual([
      67,
      67,
      9,
      CLAIM.leaseToken,
      1800,
      "temporary eBay failure",
    ]);
  });

  it("atomically completes unmanaged work and deactivates the local feed without writing a quantity", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({ rows: [{ id: 30,is_active: true,status: "active" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ product_id: 30,is_active: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ completed: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: null });
    const release = vi.fn();
    const client = { query, release } as unknown as SqlClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as SqlPool;

    await expect(markVariantAvailabilityNotApplicable(pool, CLAIM)).resolves.toBe(true);

    expect(query.mock.calls.map(([statement]) => statement.trim())).toEqual([
      "BEGIN",
      expect.stringContaining("FROM catalog.products"),
      expect.stringContaining("FROM catalog.product_variants"),
      expect.stringContaining("SELECT 1 FROM channels.channel_variant_availability_sync"),
      expect.stringContaining("UPDATE channels.channel_feeds"),
      expect.stringContaining("complete_variant_availability_claim"),
      "COMMIT",
    ]);
    expect(query.mock.calls[3][0]).not.toContain("last_synced_quantity");
    expect(query.mock.calls[4][0]).toContain("SET is_active = 0");
    expect(release).toHaveBeenCalledOnce();
  });

  it("completes a canonical handoff without claiming provider acknowledgement", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ completed: true }], rowCount: 1 });
    const pool = { query } as unknown as SqlPool;

    await expect(markVariantAvailabilityDelegated(pool, CLAIM)).resolves.toBe(true);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain("complete_variant_availability_claim");
    expect(query.mock.calls[0][0]).not.toContain("channels.channel_feeds");
    expect(query.mock.calls[0][0]).not.toContain("channels.channel_listings");
    expect(query.mock.calls[0][0]).not.toContain("last_synced_qty");
    expect(query.mock.calls[0][1]).toEqual([67, 67, 9, CLAIM.leaseToken]);
  });

  it("does not overwrite a newer revision when recording a failure", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as SqlPool;

    await expect(markVariantAvailabilityFailed(
      pool,
      CLAIM,
      new Error("late response"),
    )).resolves.toBe("superseded");
  });
});
