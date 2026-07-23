import { describe, expect, it, vi } from "vitest";

import { createChannelFulfillmentProjector } from "../../channel-fulfillment-projection.repository";

function sqlText(query: any): string {
  return (query?.queryChunks ?? query?.chunks ?? [])
    .flatMap((chunk: any) => chunk?.value ?? [String(chunk)])
    .join(" ");
}

describe("canonical channel fulfillment projector", () => {
  it("requires a positive physical shipment identity and a transaction", async () => {
    const projector = createChannelFulfillmentProjector({});

    await expect(projector.projectPhysicalShipment(0)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(projector.projectPhysicalShipment(1)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("projects only canonical package allocations and preserves terminal commercial state", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 7001 }] })
      .mockResolvedValue({ rows: [] });
    const transaction = vi.fn(async (callback: (tx: { execute: typeof execute }) => Promise<void>) =>
      callback({ execute }));
    const projector = createChannelFulfillmentProjector({ transaction });

    await projector.projectPhysicalShipment(7001);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(5);
    const statements = execute.mock.calls.map(([query]) => sqlText(query));
    expect(statements[1]).toContain("FROM wms.physical_shipment_items");
    expect(statements[1]).toContain("package.status = 'shipped'");
    expect(statements[3]).toContain("authority_fulfillable_quantity");
    expect(statements[4]).toContain("oms_order.status IN ('cancelled', 'refunded')");
    expect(statements[4]).toContain("oms_order.financial_status IN ('refunded', 'voided')");
    expect(statements.join("\n")).not.toContain("wms.outbound_shipment_items");
  });

  it("fails closed when the canonical physical shipment does not exist", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const transaction = vi.fn(async (callback: (tx: { execute: typeof execute }) => Promise<void>) =>
      callback({ execute }));
    const projector = createChannelFulfillmentProjector({ transaction });

    await expect(projector.projectPhysicalShipment(7001)).rejects.toMatchObject({
      code: "PHYSICAL_SHIPMENT_NOT_FOUND",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
