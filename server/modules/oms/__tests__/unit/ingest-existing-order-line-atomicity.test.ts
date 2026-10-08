import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { omsOrderLines, omsOrders } from "@shared/schema";

// 2026-10-06, #63964: orders/paid authorized an existing order's lines one
// transaction at a time. Line 1 committed, the handler failed before lines 2-4,
// and an orders/updated sync in between pushed a 1-item ShipStation order. All
// line authority for one ingest must commit together or not at all.

const ports = vi.hoisted(() => ({ recordAuthority: vi.fn() }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../oms-line-authority-ledger", () => ({ recordOmsLineAuthorityEvent: ports.recordAuthority }));
vi.mock("../../order-line-catalog-identity.service", () => ({
  resolveOrderLineCatalogIdentity: async () => null,
  orderLineInventoryIdentitySnapshot: () => ({}),
  recordOrderLineCatalogIdentity: async () => undefined,
}));
vi.mock("../../../order-edits/infrastructure/order-edit-ingress-guard", () => ({
  guardOrderEditShopifyIngress: async () => ({ skipOrder: false, skipLines: false }),
}));
import { createOmsService } from "../../oms.service";

const EXISTING_ORDER = { id: 55, channelId: 36, externalOrderId: "12292006838431", channelShipByDate: null };
const EXISTING_LINES = [121028, 121029, 121030, 121031].map((id, index) => ({
  id, orderId: 55, externalLineItemId: `line-${index}`, sku: `SKU-${index}`, quantity: 1,
  channelObservedQuantity: 1, paidQuantity: 0, authorityFulfillableQuantity: 0, cancelledQuantity: 0,
  refundedQuantity: 0, authorizationStatus: "seen",
}));

function fakeDatabase() {
  const committed: Array<Record<string, unknown>> = [];
  let transactions = 0;
  const select = (staged: Array<Record<string, unknown>>) => () => ({
    from: (table: unknown) => {
      const rows = table === omsOrders ? [EXISTING_ORDER] : EXISTING_LINES;
      const chain: any = {
        where: () => chain, orderBy: () => chain, for: () => chain,
        limit: async () => rows.slice(0, 1),
        then: (resolve: (value: unknown) => void) => resolve(rows),
      };
      void staged;
      return chain;
    },
  });
  const transaction = vi.fn(async (work: (tx: any) => Promise<unknown>) => {
    transactions += 1;
    const staged: Array<Record<string, unknown>> = [];
    const tx = {
      select: select(staged),
      insert: () => ({ values: () => {
        const builder: any = { onConflictDoNothing: () => builder, returning: async () => [] };
        return builder;
      } }),
      update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({
        where: async () => { if (table === omsOrderLines) staged.push(values); },
      }) }),
    };
    const result = await work(tx);
    committed.push(...staged); // Reached only when the work did not throw.
    return result;
  });
  const db = { transaction, select: select([]) };
  return { db, committed, transactionCount: () => transactions };
}

function paidIngest() {
  return {
    externalOrderNumber: "#63964",
    financialStatus: "paid",
    sourceTopic: "orders/paid",
    sourceEventId: "webhook_inbox:180711",
    lineItems: EXISTING_LINES.map((line) => ({
      externalLineItemId: line.externalLineItemId, sku: line.sku, title: line.sku,
      quantity: 1, fulfillableQuantity: 1, currentQuantity: 1, requiresShipping: true,
    })),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("re-ingesting an existing order authorizes its lines atomically", () => {
  it("authorizes every line in one transaction", async () => {
    const { db, committed, transactionCount } = fakeDatabase();
    await createOmsService(db).ingestOrder(36, EXISTING_ORDER.externalOrderId, paidIngest());
    // The insert attempt (a conflict), the order-edit pre-check, and ONE
    // transaction for all four lines (it was one per line).
    expect(transactionCount()).toBe(3);
    expect(committed).toHaveLength(4);
    expect(committed.every((line) => line.paidQuantity === 1 && line.authorityFulfillableQuantity === 1)).toBe(true);
  });

  it("commits no line when a later line fails, so no sync can see a half-authorized order", async () => {
    const { db, committed } = fakeDatabase();
    ports.recordAuthority.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("lock timeout"));
    await expect(createOmsService(db).ingestOrder(36, EXISTING_ORDER.externalOrderId, paidIngest()))
      .rejects.toThrow("lock timeout");
    expect(committed).toHaveLength(0);
  });
});
