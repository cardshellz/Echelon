import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
const query = vi.hoisted(() => vi.fn());
vi.mock("../../../../db", () => ({ pool: { query } }));
import { requireLegacyQuantityImport, sendInventoryQuantityError,
  validateInventoryCommandKey } from "../../interfaces/quantity-command.middleware";
import { InventoryQuantityError } from "../../domain/quantity-ledger";

function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
beforeEach(() => { query.mockReset(); });
describe("inventory quantity HTTP boundary", () => {
  it.each(["", " key", "key ", "k".repeat(121), 2, null, ["key"]])("rejects invalid optional key %j", commandKey => {
    const res = response(); const next = vi.fn();
    validateInventoryCommandKey({ body: { commandKey } } as Request, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(400); expect(next).not.toHaveBeenCalled();
  });
  it.each([undefined, "client-intent", "k".repeat(120)])("passes valid or legacy absent key %j to the transaction owner", commandKey => {
    const next = vi.fn();
    validateInventoryCommandKey({ body: { commandKey } } as Request, response() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });
  it("retires legacy imports only after the approved ledger opening", async () => {
    const next = vi.fn(); const res = response();
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ command_id: "1" }] });
    await requireLegacyQuantityImport({} as Request, res as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    next.mockClear();
    await requireLegacyQuantityImport({} as Request, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(409); expect(next).not.toHaveBeenCalled();
  });
  it("does not interpret an unavailable authority query as permission to import", async () => {
    const error = new Error("Database unavailable"); query.mockRejectedValue(error);
    const next = vi.fn();
    await requireLegacyQuantityImport({} as Request, response() as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith(error);
  });
  it("returns actionable structured conflicts but does not mask unrelated failures", () => {
    const res = response();
    expect(sendInventoryQuantityError(res as unknown as Response,
      new InventoryQuantityError("QUANTITY_LEGACY_WRITER_RETIRED", "Use receiving"))).toBe(true);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "QUANTITY_LEGACY_WRITER_RETIRED", error: "Use receiving" }));
    expect(sendInventoryQuantityError(res as unknown as Response, new Error("Unexpected"))).toBe(false);
  });
});
