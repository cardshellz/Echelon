import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { withEbayListingJobProgress } from "../../infrastructure/ebay-listing-job-progress.reader";
import type { EbayListingSyncJob } from "@shared/types/ebay-listing-sync";

const at = "2026-10-15T12:00:00.000Z";
const job: EbayListingSyncJob = {
  id: "b41193e0-a37e-4e21-9bd5-e2f7002b1a05", productId: 20, kind: "sync", operation: "sync",
  state: "queued", code: null, message: null, nextAttemptAt: at, updatedAt: at,
};
const row = { id: job.id, state: "queued", updated_at: new Date(at), requested_at: new Date(at),
  last_activity_at: new Date(at), last_worker_activity_at: null, stage_key: null, stage_event: null, queued_ahead: 2 };
function client(rows: unknown[]): Pick<Pool, "query"> {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}
describe("listing progress read consistency", () => {
  it.each([{ ...row, state: "completed" }, { ...row, updated_at: new Date("2026-10-15T12:01:00Z") }])(
    "omits progress when the job changed between reads", async current => {
      expect(await withEbayListingJobProgress(client([current]), [job])).toEqual([job]);
    },
  );
  it("validates the additive public contract before returning it", async () => {
    await expect(withEbayListingJobProgress(client([{ ...row, queued_ahead: -1 }]), [job])).rejects.toThrow();
  });
  it("does not query worker progress for an admission rejection", async () => {
    const pool = client([]), admission = { ...job, kind: "admission" as const };
    expect(await withEbayListingJobProgress(pool, [admission])).toEqual([admission]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
