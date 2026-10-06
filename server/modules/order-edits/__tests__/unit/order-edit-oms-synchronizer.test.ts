import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalAvailabilityReservationStatusProjectionSchema,
  type CanonicalAvailabilityReservationStatusProjection,
} from "@shared/types/inventory-availability-claims";
import type { OrderEditSnapshot } from "../../application/order-edit-provider";
import { OrderEditOmsSynchronizer } from "../../infrastructure/order-edit-oms-synchronizer";

type Claim = NonNullable<
  CanonicalAvailabilityReservationStatusProjection["claim"]
>;
const OP = "11111111-1111-4111-8111-111111111111";
type ClaimLine = Claim["lines"][number];
type OmsLine = {
  external_line_item_id: string;
  quantity: number;
  authority_fulfillable_quantity: number;
  product_variant_id: number | null;
};
type WmsItem = {
  id: number;
  order_id: number;
  quantity: number;
  product_variant_id: number;
  source_variant_id: number;
};

function paidSnapshot(): OrderEditSnapshot {
  return {
    connectionId: 4,
    channelId: 36,
    orderId: "gid://shopify/Order/100",
    name: "#100",
    customerId: "gid://shopify/Customer/8",
    currency: "USD",
    updatedAt: "2026-10-05T12:00:00.000Z",
    editable: true,
    editableErrors: [],
    cancelled: false,
    closed: false,
    fullyPaid: true,
    totalCents: 2000,
    outstandingCents: 0,
    subtotalCents: 2000,
    taxCents: 0,
    netPaidCents: 2000,
    capturableCents: 0,
    shippingCents: 0,
    paymentUrl: null,
    memberPlan: null,
    memberPricingEnabled: false,
    discountsPresent: false,
    lines: [
      {
        id: "gid://shopify/LineItem/1",
        variantId: "gid://shopify/ProductVariant/10",
        title: "Binder",
        variantTitle: "Single",
        sku: "BINDER",
        quantity: 2,
        unfulfilledQuantity: 2,
        originalUnitPriceCents: 1000,
        discountedUnitPriceCents: 1000,
        totalCents: 2000,
        discountFingerprint: "none",
        unsupported: false,
      },
    ],
    transactions: [],
    refunds: [],
    contentFingerprint: "verified-contents",
    fingerprint: "verified-order",
    evidence: {},
  };
}

function claimLine(itemId = 101, quantity = "2"): ClaimLine {
  return {
    claimLineId: String(itemId),
    lineKey: `item:${itemId}`,
    orderItemId: itemId,
    sku: "BINDER",
    targetVariantId: 10,
    requestedQty: quantity,
    plannedQty: quantity,
    shortfallQty: "0",
    releasedTargetQty: "0",
    consumedTargetQty: "0",
    pickedTargetQty: "0",
    openPlannedQty: quantity,
    resources: [],
    operations: [],
  };
}

function reservation(
  orderId = 9,
  lines = [claimLine()],
): CanonicalAvailabilityReservationStatusProjection {
  // Parse the baseline fixture so a malformed fixture cannot make rejection cases pass accidentally.
  return canonicalAvailabilityReservationStatusProjectionSchema.parse({
    schemaVersion: "inventory_availability_reservation_status_v1",
    authority: "canonical",
    authorityRevision: "7",
    activationRunId: "3",
    orderId,
    claim: {
      claimId: "44",
      claimKey: `order:${orderId}`,
      revision: 2,
      activationRunId: "3",
      runtimeAuthorityRevision: "7",
      planStatus: "satisfied",
      scope: { kind: "warehouse", warehouseId: 1 },
      planHash: "a".repeat(64),
      snapshotFingerprint: "b".repeat(64),
      lines,
    },
  });
}

function harness() {
  const data: {
    header: unknown;
    lines: OmsLine[];
    items: WmsItem[];
    reservation: unknown;
  } = {
    header: {
      channel_id: 36,
      external_order_id: "100",
      currency: "USD",
      total_cents: 2000,
      cancelled_at: null,
    },
    lines: [
      {
        external_line_item_id: "1",
        quantity: 2,
        authority_fulfillable_quantity: 2,
        product_variant_id: 10,
      },
    ],
    items: [
      {
        id: 101,
        order_id: 9,
        quantity: 2,
        product_variant_id: 10,
        source_variant_id: 10,
      },
    ],
    reservation: reservation(),
  };
  const sequence: string[] = [];
  const query = vi.fn(async (statement: string, parameters?: unknown[]) => {
    expect(parameters).toEqual([51]);
    if (statement.includes("FROM oms.oms_orders")) {
      sequence.push("header");
      return { rows: data.header === undefined ? [] : [data.header] };
    }
    if (statement.includes("FROM oms.oms_order_lines")) {
      sequence.push("authority");
      return { rows: data.lines };
    }
    if (statement.includes("FROM wms.order_items")) {
      sequence.push("items");
      return { rows: data.items };
    }
    throw new Error(`Unexpected synchronizer query: ${statement}`);
  });
  const syncOmsOrderToWms = vi.fn(
    async (_orderId: number): Promise<number | null> => {
      sequence.push("sync");
      return 9;
    },
  );
  const getOrderReservationStatus = vi.fn(
    async (_orderId: number): Promise<unknown> => {
      sequence.push("claim");
      return data.reservation;
    },
  );
  const projectPaidOrder = vi.fn(
    async (
      _orderId: number,
      _operationId: string,
      _snapshot: OrderEditSnapshot,
    ) => {
      sequence.push("project");
    },
  );
  const synchronizer = new OrderEditOmsSynchronizer(
    { query } as unknown as Pick<Pool, "query">,
    { syncOmsOrderToWms },
    { getOrderReservationStatus },
    projectPaidOrder,
  );
  return {
    data,
    query,
    sequence,
    projectPaidOrder,
    syncOmsOrderToWms,
    getOrderReservationStatus,
    synchronizer,
  };
}

describe("order edit OMS synchronization authority", () => {
  it("synchronizes only after matching paid header and exact line authority, then verifies canonical quantities", async () => {
    const h = harness();
    await h.synchronizer.synchronize(51, paidSnapshot(), OP);
    expect(h.sequence).toEqual([
      "project",
      "header",
      "authority",
      "sync",
      "items",
      "claim",
    ]);
    expect(h.projectPaidOrder).toHaveBeenCalledExactlyOnceWith(
      51,
      OP,
      paidSnapshot(),
    );
    expect(h.syncOmsOrderToWms).toHaveBeenCalledExactlyOnceWith(51);
    expect(h.getOrderReservationStatus).toHaveBeenCalledExactlyOnceWith(9);
    expect(
      h.query.mock.calls.every(([statement]) => statement.startsWith("SELECT")),
    ).toBe(true);
  });

  it.each([
    { fullyPaid: false },
    { outstandingCents: 1 },
    { netPaidCents: 1999 },
  ])(
    "does not read or sync before payment evidence is exact: %o",
    async (change) => {
      const h = harness();
      await expect(
        h.synchronizer.synchronize(51, { ...paidSnapshot(), ...change }, OP),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_PAYMENT_REQUIRED" });
      expect(h.projectPaidOrder).not.toHaveBeenCalled();
      expect(h.query).not.toHaveBeenCalled();
      expect(h.syncOmsOrderToWms).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", undefined],
    [
      "wrong channel",
      {
        channel_id: 99,
        external_order_id: "100",
        currency: "USD",
        total_cents: 2000,
        cancelled_at: null,
      },
    ],
    [
      "wrong order",
      {
        channel_id: 36,
        external_order_id: "101",
        currency: "USD",
        total_cents: 2000,
        cancelled_at: null,
      },
    ],
    [
      "lagging total",
      {
        channel_id: 36,
        external_order_id: "100",
        currency: "USD",
        total_cents: 1000,
        cancelled_at: null,
      },
    ],
    [
      "cancelled",
      {
        channel_id: 36,
        external_order_id: "100",
        currency: "USD",
        total_cents: 2000,
        cancelled_at: "2026-10-05",
      },
    ],
  ])("blocks %s OMS header", async (_label, header) => {
    const h = harness();
    h.data.header = header;
    await expect(
      h.synchronizer.synchronize(51, paidSnapshot(), OP),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_OMS_PENDING" });
    expect(h.syncOmsOrderToWms).not.toHaveBeenCalled();
    expect(h.getOrderReservationStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", []],
    [
      "lagging quantity",
      [
        {
          external_line_item_id: "1",
          quantity: 1,
          authority_fulfillable_quantity: 1,
          product_variant_id: 10,
        },
      ],
    ],
    [
      "lagging paid authority",
      [
        {
          external_line_item_id: "1",
          quantity: 2,
          authority_fulfillable_quantity: 1,
          product_variant_id: 10,
        },
      ],
    ],
    [
      "unmapped variant",
      [
        {
          external_line_item_id: "1",
          quantity: 2,
          authority_fulfillable_quantity: 2,
          product_variant_id: null,
        },
      ],
    ],
  ] satisfies Array<[string, OmsLine[]]>)(
    "blocks %s OMS line authority",
    async (_label, lines) => {
      const h = harness();
      h.data.lines = lines;
      await expect(
        h.synchronizer.synchronize(51, paidSnapshot(), OP),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_OMS_LINES_PENDING" });
      expect(h.syncOmsOrderToWms).not.toHaveBeenCalled();
      expect(h.getOrderReservationStatus).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate normalized source line IDs before WMS synchronization", async () => {
    const h = harness();
    h.data.lines.push({
      ...h.data.lines[0],
      external_line_item_id: "gid://shopify/LineItem/1",
    });
    await expect(
      h.synchronizer.synchronize(51, paidSnapshot(), OP),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_OMS_LINES_PENDING" });
    expect(h.syncOmsOrderToWms).not.toHaveBeenCalled();
  });

  it("accepts retired zero-quantity OMS lines while requiring all added positive lines", async () => {
    const h = harness();
    h.data.lines.push({
      external_line_item_id: "removed",
      quantity: 0,
      authority_fulfillable_quantity: 0,
      product_variant_id: null,
    });
    await expect(
      h.synchronizer.synchronize(51, paidSnapshot(), OP),
    ).resolves.toBeUndefined();
    const changed = paidSnapshot();
    changed.lines.push({
      ...changed.lines[0],
      id: "gid://shopify/LineItem/2",
      quantity: 1,
    });
    h.syncOmsOrderToWms.mockClear();
    await expect(
      h.synchronizer.synchronize(51, changed, OP),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_OMS_LINES_PENDING" });
    expect(h.syncOmsOrderToWms).not.toHaveBeenCalled();
  });

  it("propagates a WMS sync failure without treating an old inventory claim as proof", async () => {
    const h = harness();
    const failure = new Error("sync failed");
    h.syncOmsOrderToWms.mockRejectedValue(failure);
    await expect(
      h.synchronizer.synchronize(51, paidSnapshot(), OP),
    ).rejects.toBe(failure);
    expect(h.getOrderReservationStatus).not.toHaveBeenCalled();
  });
});

describe("order edit canonical inventory evidence", () => {
  it("preserves larger purchased quantities after a certified reduction or removal", async () => {
    const h = harness();
    h.data.lines[0].quantity = 5;
    h.data.lines.push({
      external_line_item_id: "removed",
      quantity: 3,
      authority_fulfillable_quantity: 0,
      product_variant_id: 20,
    });
    await expect(
      h.synchronizer.synchronize(51, paidSnapshot(), OP),
    ).resolves.toBeUndefined();
    expect(h.syncOmsOrderToWms).toHaveBeenCalledOnce();
  });
  it("does not sync if the OMS owner refuses the paid-current projection", async () => {
    const h = harness();
    const failure = new Error("Projection does not match the persisted edit");
    h.projectPaidOrder.mockRejectedValueOnce(failure);
    await expect(
      h.synchronizer.synchronize(51, paidSnapshot(), OP),
    ).rejects.toBe(failure);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.syncOmsOrderToWms).not.toHaveBeenCalled();
  });
  it("blocks a WMS variant that does not match its source OMS line before reading a claim", async () => {
    const h = harness();
    h.data.items = [{ ...h.data.items[0], product_variant_id: 99 }];
    await expect(
      h.synchronizer.synchronize(51, paidSnapshot(), OP),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_INVENTORY_PENDING" });
    expect(h.getOrderReservationStatus).not.toHaveBeenCalled();
  });

  it.each([
    "missing projection",
    "missing claim",
    "partial plan",
    "different WMS order",
  ])("blocks %s", async (scenario) => {
    const h = harness();
    const status = reservation();
    if (scenario === "missing projection") h.data.reservation = null;
    if (scenario === "missing claim")
      h.data.reservation = { ...status, claim: null };
    if (scenario === "partial plan")
      h.data.reservation = {
        ...status,
        claim: { ...status.claim, planStatus: "partial" },
      };
    if (scenario === "different WMS order")
      h.data.reservation = { ...status, orderId: 10 };
    await expect(
      h.synchronizer.synchronize(51, paidSnapshot(), OP),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_INVENTORY_PENDING" });
    expect(h.syncOmsOrderToWms).toHaveBeenCalledOnce();
  });

  it.each([
    ["requested quantity", { requestedQty: "3" }],
    ["open planned quantity", { openPlannedQty: "1" }],
    ["shortfall", { shortfallQty: "1" }],
    ["already picked units", { pickedTargetQty: "1" }],
    ["already consumed units", { consumedTargetQty: "1" }],
    ["different item", { orderItemId: 102 }],
    ["different product variant", { targetVariantId: 99 }],
  ] satisfies Array<[string, Partial<ClaimLine>]>)(
    "blocks mismatched %s even when plan says satisfied",
    async (_label, change) => {
      const h = harness();
      h.data.reservation = reservation(9, [{ ...claimLine(), ...change }]);
      await expect(
        h.synchronizer.synchronize(51, paidSnapshot(), OP),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_INVENTORY_PENDING" });
    },
  );

  it.each([{ lines: [] }, { lines: [claimLine(), claimLine()] }])(
    "rejects missing or duplicate item allocations",
    async ({ lines }) => {
      const h = harness();
      h.data.reservation = reservation(9, lines);
      await expect(
        h.synchronizer.synchronize(51, paidSnapshot(), OP),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_INVENTORY_PENDING" });
    },
  );

  it("requires exact claims independently for every WMS partition", async () => {
    const h = harness();
    h.data.items = [
      {
        id: 101,
        order_id: 9,
        quantity: 1,
        product_variant_id: 10,
        source_variant_id: 10,
      },
      {
        id: 102,
        order_id: 10,
        quantity: 1,
        product_variant_id: 10,
        source_variant_id: 10,
      },
    ];
    h.getOrderReservationStatus.mockImplementation(async (id) =>
      reservation(id, [claimLine(id === 9 ? 101 : 102, "1")]),
    );
    await expect(
      h.synchronizer.synchronize(51, paidSnapshot(), OP),
    ).resolves.toBeUndefined();
    expect(h.getOrderReservationStatus.mock.calls.map(([id]) => id)).toEqual([
      9, 10,
    ]);
  });
});
