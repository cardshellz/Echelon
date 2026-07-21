import { describe, expect, it, vi } from "vitest";
import { VendorService } from "../../vendor.service";

function buildHarness() {
  const auditValues = vi.fn(async () => []);
  const tx = {
    execute: vi.fn(async () => ({ rows: [] })),
    insert: vi.fn(() => ({ values: auditValues })),
  };
  const database = {
    transaction: vi.fn(async (callback: (executor: any) => Promise<any>) => await callback(tx)),
  };
  const storage = {
    getVendorById: vi.fn(),
    getVendorByCode: vi.fn(),
    createVendor: vi.fn(),
    updateVendor: vi.fn(),
  };
  const now = new Date("2026-07-20T15:00:00.000Z");
  const service = new VendorService(database as any, storage as any, () => now);
  return { auditValues, database, now, service, storage, tx };
}

describe("VendorService", () => {
  it("normalizes, creates, and audits a vendor in one transaction", async () => {
    const { auditValues, database, now, service, storage, tx } = buildHarness();
    storage.getVendorByCode.mockResolvedValue(undefined);
    storage.createVendor.mockResolvedValue({
      id: 11,
      code: "ACME",
      name: "Acme Supply",
      email: "buyer@acme.test",
      currency: "USD",
      active: 1,
    });

    const result = await service.create({
      code: " acme ",
      name: " Acme Supply ",
      email: "BUYER@ACME.TEST",
      currency: "usd",
      minimumOrderCents: 12500,
    }, "user:7");

    expect(database.transaction).toHaveBeenCalledOnce();
    expect(storage.getVendorByCode).toHaveBeenCalledWith("ACME", tx);
    expect(storage.createVendor).toHaveBeenCalledWith({
      code: "ACME",
      name: "Acme Supply",
      email: "buyer@acme.test",
      currency: "USD",
      minimumOrderCents: 12500,
    }, tx);
    expect(result).toMatchObject({ id: 11, code: "ACME" });
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      timestamp: now,
      actor: "user:7",
      action: "procurement.vendor.create",
      target: "procurement.vendor:11",
    }));
  });

  it("rejects unchecked fields and fractional money before opening a transaction", async () => {
    const { database, service } = buildHarness();

    await expect(service.update(11, { createdAt: new Date() }, "user:7")).rejects.toMatchObject({
      statusCode: 400,
      details: expect.objectContaining({ code: "INVALID_VENDOR_FIELDS" }),
    });
    await expect(service.update(11, { minimumOrderCents: 12.5 }, "user:7")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("deactivates instead of deleting a vendor and records before/after state", async () => {
    const { auditValues, service, storage, tx } = buildHarness();
    const before = { id: 11, code: "ACME", name: "Acme", active: 1 };
    const after = { ...before, active: 0 };
    storage.getVendorById.mockResolvedValue(before);
    storage.updateVendor.mockResolvedValue(after);

    const result = await service.deactivate(11, "user:7");

    expect(tx.execute).toHaveBeenCalledOnce();
    expect(storage.updateVendor).toHaveBeenCalledWith(11, { active: 0 }, tx);
    expect(result).toEqual(after);
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      action: "procurement.vendor.deactivate",
      changes: { before, after },
    }));
  });

  it("maps concurrent duplicate vendor codes to a conflict", async () => {
    const { service, storage } = buildHarness();
    storage.getVendorByCode.mockResolvedValue(undefined);
    storage.createVendor.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "23505" }));

    await expect(service.create({ code: "ACME", name: "Acme" }, "user:7")).rejects.toMatchObject({
      statusCode: 409,
      message: "Vendor code already exists",
    });
  });
});
