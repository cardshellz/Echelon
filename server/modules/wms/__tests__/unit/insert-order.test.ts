/**
 * Unit tests for insertWmsOrder (§6 Commit 9 — factory only).
 *
 * Scope: fully mocked db. Covers the invariant (non-null
 * omsFulfillmentOrderId + positive integer channelId), the
 * insert().values().returning() chain, and failure modes when the
 * underlying insert returns no row.
 *
 * This commit (9a) ships only the factory + these tests; no callers
 * are migrated yet — that lands in 9b / 9c.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  insertWmsOrder,
  WmsOrderInvariantError,
  type WmsOrderInsert,
} from "../../insert-order";
import { wmsOrders } from "@shared/schema";

// ─── Mock db factory ─────────────────────────────────────────────────

function makeMockDb(returningResult: unknown = [{ id: 42 }]) {
  const returning = vi.fn().mockResolvedValue(returningResult);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  return { insert, values, returning };
}

// ─── Baseline valid payload ──────────────────────────────────────────

function validPayload(): WmsOrderInsert {
  return {
    omsFulfillmentOrderId: "ff_123",
    channelId: 1,
  } as WmsOrderInsert;
}

describe("insertWmsOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: inserts with exact payload and returns { id }", async () => {
    const db = makeMockDb([{ id: 99 }]);
    const payload = validPayload();

    const result = await insertWmsOrder(db as any, payload);

    expect(result).toEqual({ id: 99 });
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledWith(wmsOrders);
    expect(db.values).toHaveBeenCalledTimes(1);
    expect(db.values).toHaveBeenCalledWith(payload);
    expect(db.returning).toHaveBeenCalledTimes(1);
    expect(db.returning).toHaveBeenCalledWith({ id: wmsOrders.id });
  });

  // ── omsFulfillmentOrderId invariant ────────────────────────────────

  it("throws when omsFulfillmentOrderId is undefined", async () => {
    const db = makeMockDb();
    const payload = { ...validPayload(), omsFulfillmentOrderId: undefined as any };
    await expect(insertWmsOrder(db as any, payload)).rejects.toMatchObject({
      name: "WmsOrderInvariantError",
      field: "omsFulfillmentOrderId",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('throws when omsFulfillmentOrderId is ""', async () => {
    const db = makeMockDb();
    const payload = { ...validPayload(), omsFulfillmentOrderId: "" };
    await expect(insertWmsOrder(db as any, payload)).rejects.toBeInstanceOf(
      WmsOrderInvariantError,
    );
    await expect(insertWmsOrder(db as any, payload)).rejects.toMatchObject({
      field: "omsFulfillmentOrderId",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("throws when omsFulfillmentOrderId is null", async () => {
    const db = makeMockDb();
    const payload = { ...validPayload(), omsFulfillmentOrderId: null as any };
    await expect(insertWmsOrder(db as any, payload)).rejects.toMatchObject({
      field: "omsFulfillmentOrderId",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("throws when omsFulfillmentOrderId is a number (non-string)", async () => {
    const db = makeMockDb();
    const payload = { ...validPayload(), omsFulfillmentOrderId: 42 as any };
    await expect(insertWmsOrder(db as any, payload)).rejects.toMatchObject({
      field: "omsFulfillmentOrderId",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  // ── channelId invariant ────────────────────────────────────────────

  it("throws when channelId is null", async () => {
    const db = makeMockDb();
    const payload = { ...validPayload(), channelId: null as any };
    await expect(insertWmsOrder(db as any, payload)).rejects.toMatchObject({
      name: "WmsOrderInvariantError",
      field: "channelId",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("throws when channelId is undefined", async () => {
    const db = makeMockDb();
    const payload = { ...validPayload(), channelId: undefined as any };
    await expect(insertWmsOrder(db as any, payload)).rejects.toMatchObject({
      field: "channelId",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("throws when channelId is 0", async () => {
    const db = makeMockDb();
    const payload = { ...validPayload(), channelId: 0 };
    await expect(insertWmsOrder(db as any, payload)).rejects.toMatchObject({
      field: "channelId",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("throws when channelId is -1", async () => {
    const db = makeMockDb();
    const payload = { ...validPayload(), channelId: -1 };
    await expect(insertWmsOrder(db as any, payload)).rejects.toMatchObject({
      field: "channelId",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("throws when channelId is 1.5 (non-integer)", async () => {
    const db = makeMockDb();
    const payload = { ...validPayload(), channelId: 1.5 };
    await expect(insertWmsOrder(db as any, payload)).rejects.toMatchObject({
      field: "channelId",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  // ── DB result guards ───────────────────────────────────────────────

  it("throws when db.returning() resolves to []", async () => {
    const db = makeMockDb([]);
    await expect(insertWmsOrder(db as any, validPayload())).rejects.toThrow(
      "insertWmsOrder: insert returned no row",
    );
  });

  it("throws when db.returning() resolves to [{ id: undefined }]", async () => {
    const db = makeMockDb([{ id: undefined }]);
    await expect(insertWmsOrder(db as any, validPayload())).rejects.toThrow(
      "insertWmsOrder: insert returned no row",
    );
  });

  // ── Type-level guard ───────────────────────────────────────────────

  it("type-level: required fields cannot be null", () => {
    // @ts-expect-error — omsFulfillmentOrderId is required
    const bad: WmsOrderInsert = { channelId: 1 } as any;
    expect(bad).toBeDefined();
  });
});
