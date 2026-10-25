import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../purchase-order-work-list.repository", () => ({ readPurchaseOrderWorkList: mocks.read }));
import { getPurchaseOrderWorkList } from "../../purchase-order-work-list.service";

describe("purchase order selection application policy", () => {
  beforeEach(() => { mocks.read.mockReset(); mocks.read.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0, nextOffset: null }); });
  it.each([
    ["invoice-create", ["cancelled", "voided", "closed"]],
    ["invoice-link", []],
    ["shipment-lines", []],
  ] as const)("resolves %s filters before the repository", async (purpose, excludedStatuses) => {
    await getPurchaseOrderWorkList({ purpose, vendorId: "6", search: "PO-225" });
    expect(mocks.read).toHaveBeenCalledWith({ vendorId: 6, search: "PO-225", limit: 20, offset: 0, excludedStatuses });
    expect(mocks.read.mock.calls[0][0]).not.toHaveProperty("purpose");
  });
  it("allows unscoped supplier search only for shipment line selection", async () => {
    await getPurchaseOrderWorkList({ purpose: "shipment-lines" });
    expect(mocks.read.mock.calls[0][0]).not.toHaveProperty("vendorId");
    mocks.read.mockClear();
    for (const purpose of ["invoice-create", "invoice-link"]) await expect(getPurchaseOrderWorkList({ purpose })).rejects.toThrow();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects invalid pagination before reading", async () => {
    await expect(getPurchaseOrderWorkList({ purpose: "shipment-lines", offset: "-1" })).rejects.toThrow();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects an unverified page rather than claiming no matching orders", async () => {
    mocks.read.mockResolvedValue({ items: [], total: 20, limit: 20, offset: 0, nextOffset: null });
    await expect(getPurchaseOrderWorkList({ purpose: "shipment-lines" })).rejects.toThrow("Purchase order selection could not be verified");
  });
});
