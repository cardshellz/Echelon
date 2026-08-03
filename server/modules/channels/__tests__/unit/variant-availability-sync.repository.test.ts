import { describe, expect, it, vi } from "vitest";
import {
  claimVariantAvailabilitySyncs,
  enqueueVariantAvailabilitySync,
  markVariantAvailabilityFailed,
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
};

describe("variant availability sync repository", () => {
  it("atomically enqueues the requested desired state", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const pool = { query } as unknown as SqlPool;

    await expect(enqueueVariantAvailabilitySync(pool, {
      channelId: 67,
      productVariantId: 438,
      desiredActive: false,
    })).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain("INSERT INTO channels.channel_variant_availability_sync");
    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (channel_id, product_variant_id)");
    expect(query.mock.calls[0][0]).toContain("revision = channels.channel_variant_availability_sync.revision + 1");
    expect(query.mock.calls[0][1]).toEqual([67, 438, false]);
  });

  it("rejects invalid enqueue identifiers before writing", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as SqlPool;

    await expect(enqueueVariantAvailabilitySync(pool, {
      channelId: 0,
      productVariantId: 438,
      desiredActive: false,
    })).rejects.toThrow("channelId must be a positive safe integer");
    expect(query).not.toHaveBeenCalled();
  });

  it("claims due work with a transaction, lease, and SKIP LOCKED", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null })
      .mockResolvedValueOnce({
        rows: [{
          channel_id: 67,
          product_variant_id: 67,
          desired_active: false,
          revision: "9",
          attempt_count: 2,
          lease_token: "00000000-0000-4000-8000-000000000002",
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
    }]);

    expect(query.mock.calls[0][0]).toBe("BEGIN");
    expect(query.mock.calls[1][0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.mock.calls[1][0]).toContain("lease_expires_at");
    expect(query.mock.calls[2][0]).toBe("COMMIT");
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
