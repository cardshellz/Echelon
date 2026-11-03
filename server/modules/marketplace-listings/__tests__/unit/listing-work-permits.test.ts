import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { withListingWorkPermit } from "../../listing-work-permits";

describe("shared listing work permit cleanup", () => {
  function fixture() {
    const client = { query: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pick<Pool, "connect">;
    return { client, pool };
  }
  it("does not run inspection when both permits are occupied", async () => {
    const f = fixture(); f.client.query.mockResolvedValue({ rows: [{ acquired: false }] });
    const work = vi.fn();
    await expect(withListingWorkPermit(f.pool, work)).resolves.toEqual({ available: false });
    expect(work).not.toHaveBeenCalled(); expect(f.client.release).toHaveBeenCalledWith(false);
  });
  it("releases the permit when inspection fails", async () => {
    const f = fixture();
    f.client.query.mockResolvedValueOnce({ rows: [{ acquired: true }] }).mockResolvedValueOnce({ rows: [{ released: true }] });
    const failure = new Error("synthetic inspection failure");
    await expect(withListingWorkPermit(f.pool, async () => { throw failure; })).rejects.toBe(failure);
    expect(f.client.release).toHaveBeenCalledWith(false);
  });
  it("discards a session after an uncertain acquisition", async () => {
    const f = fixture(); const failure = new Error("synthetic lost acquisition response");
    f.client.query.mockRejectedValue(failure);
    await expect(withListingWorkPermit(f.pool, async () => 1)).rejects.toBe(failure);
    expect(f.client.release).toHaveBeenCalledWith(true);
  });
  it("preserves the inspection error and discards the session when unlock fails", async () => {
    const f = fixture();
    f.client.query.mockResolvedValueOnce({ rows: [{ acquired: true }] }).mockRejectedValueOnce(new Error("synthetic unlock failure"));
    const failure = new Error("synthetic inspection failure");
    const result = await withListingWorkPermit(f.pool, async () => { throw failure; }).catch(error => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors[0]).toBe(failure);
    expect(f.client.release).toHaveBeenCalledWith(true);
  });
});
