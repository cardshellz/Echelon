/**
 * Pick priority for Dropship orders: the score is the shipping base plus the
 * VENDOR's plan modifier, never the buyer's. Values mirror production order
 * 22039 (OMS order 1013417): Dropship OMS channel 103, vendor 1 on `.ops`
 * (+100), standard shipping base 100. Before the fix it scored 100 with no
 * plan because its buyer is not a Card Shellz member.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  execute: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../../../db", () => ({ db: { execute: harness.execute } }));
vi.mock("../../../orders/sort-rank", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../orders/sort-rank")>()),
  // priority.shipping_base.standard in production.
  getShippingBase: async () => 100,
}));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: harness.info, warn: harness.warn, error: vi.fn() },
}));

import { WmsSyncService } from "../../wms-sync.service";

const DROPSHIP_OMS_CHANNEL_ID = 103;
const SHOPIFY_CHANNEL_ID = 36;
const OPS_PLAN_ID = "14d8698f-09d8-4dea-8089-fa9a1ec0fb28";
const OPS_PLAN_ROW = { priority_modifier: 100, name: ".ops", primary_color: "#C060E0" };
const CLUB_PLAN_ROW = { priority_modifier: 50, name: ".club", primary_color: "#2E86DE" };

interface PriorityResult {
  priority: number;
  memberPlanName: string | null;
  memberPlanColor: string | null;
}

interface Statement {
  text: string;
  params: unknown[];
}

/** Splits a drizzle `sql` template into its text and its bound parameters. */
function statement(query: unknown): Statement {
  const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  const text: string[] = [];
  const params: unknown[] = [];
  for (const chunk of chunks) {
    const value = (chunk as { value?: unknown } | null)?.value;
    if (Array.isArray(value)) {
      text.push(...value.map(String));
    } else {
      text.push("?");
      params.push(chunk);
    }
  }
  return { text: text.join(""), params };
}

function executed(): Statement[] {
  return harness.execute.mock.calls.map(([query]) => statement(query));
}

const isPlanByIdQuery = (s: Statement) => s.text.includes("FROM membership.plans") && s.text.includes("WHERE id = ?");
const isBuyerMembershipQuery = (s: Statement) => s.text.includes("membership.member_subscriptions");
const isMemberTierQuery = (s: Statement) => s.text.includes("LOWER(name) = LOWER(?)");

/** Answers each query shape with its rows; anything else returns no rows. */
function answer(rows: {
  planById?: Array<Record<string, unknown>> | Error;
  buyerMembership?: Array<Record<string, unknown>>;
  memberTier?: Array<Record<string, unknown>>;
}): void {
  harness.execute.mockImplementation(async (query: unknown) => {
    const s = statement(query);
    if (isPlanByIdQuery(s)) {
      if (rows.planById instanceof Error) throw rows.planById;
      return { rows: rows.planById ?? [] };
    }
    if (isBuyerMembershipQuery(s)) return { rows: rows.buyerMembership ?? [] };
    if (isMemberTierQuery(s)) return { rows: rows.memberTier ?? [] };
    return { rows: [] };
  });
}

function createService(
  resolveChannelId: () => Promise<number> = async () => DROPSHIP_OMS_CHANNEL_ID,
): WmsSyncService {
  return new WmsSyncService({
    inventoryCore: {},
    reservation: {},
    fulfillmentRouter: {},
    dropshipOmsChannel: { resolveChannelId },
  });
}

function determinePriority(service: WmsSyncService, omsOrder: Record<string, unknown>): Promise<PriorityResult> {
  return (service as unknown as {
    determinePriority(order: Record<string, unknown>): Promise<PriorityResult>;
  }).determinePriority(omsOrder);
}

function dropshipOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1013417,
    channelId: DROPSHIP_OMS_CHANNEL_ID,
    customerEmail: "buyer@example.com",
    memberTier: null,
    shippingServiceLevel: "standard",
    rawPayload: {
      dropship: {
        intakeId: 43,
        vendorId: 1,
        storeConnectionId: 1,
        vendorMembershipPlanId: OPS_PLAN_ID,
        externalOrderId: "22039",
        buyerShippingServiceCode: "USPSParcel",
      },
      marketplace: {},
    },
    ...overrides,
  };
}

function shopifyOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 2001,
    channelId: SHOPIFY_CHANNEL_ID,
    customerEmail: "member@example.com",
    memberTier: null,
    shippingServiceLevel: "standard",
    rawPayload: { customer: { id: 555 } },
    ...overrides,
  };
}

function warnings(): Array<Record<string, unknown>> {
  return harness.warn.mock.calls
    .filter(([action]) => action === "wms_sync_dropship_pick_priority")
    .map(([, data]) => data as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.execute.mockReset();
});

describe("WmsSyncService pick priority for Dropship orders", () => {
  it("scores 22039 with the vendor's .ops modifier: 100 + 100", async () => {
    answer({ planById: [OPS_PLAN_ROW] });

    const result = await determinePriority(createService(), dropshipOrder());

    expect(result).toEqual({ priority: 200, memberPlanName: ".ops", memberPlanColor: "#C060E0" });
    const planQueries = executed().filter(isPlanByIdQuery);
    expect(planQueries).toHaveLength(1);
    expect(planQueries[0].params).toEqual([OPS_PLAN_ID]);
    expect(harness.info).toHaveBeenCalledWith("wms_sync_dropship_pick_priority", {
      oms_order_id: 1013417,
      channel_id: DROPSHIP_OMS_CHANNEL_ID,
      outcome: "vendor_plan_applied",
      plan_id: OPS_PLAN_ID,
      priority_modifier: 100,
    });
    expect(warnings()).toEqual([]);
  });

  it("never scores a Dropship order from its buyer, even when the buyer is a member", async () => {
    answer({ planById: [OPS_PLAN_ROW], buyerMembership: [CLUB_PLAN_ROW], memberTier: [CLUB_PLAN_ROW] });

    const result = await determinePriority(createService(), dropshipOrder({ memberTier: ".club" }));

    expect(result.priority).toBe(200);
    expect(result.memberPlanName).toBe(".ops");
    expect(executed().filter(isBuyerMembershipQuery)).toEqual([]);
    expect(executed().filter(isMemberTierQuery)).toEqual([]);
  });

  it("recognises a stamped Dropship order when the Dropship channel cannot be resolved", async () => {
    answer({ planById: [OPS_PLAN_ROW] });
    const service = createService(async () => {
      throw Object.assign(new Error("channel lookup failed"), { code: "DROPSHIP_OMS_CHANNEL_NOT_FOUND" });
    });

    const result = await determinePriority(service, dropshipOrder());

    expect(result.priority).toBe(200);
    expect(executed().filter(isBuyerMembershipQuery)).toEqual([]);
  });

  it("scores the shipping base alone for an order accepted before the plan was recorded", async () => {
    answer({ buyerMembership: [CLUB_PLAN_ROW] });
    const legacyStamp = { dropship: { intakeId: 43, vendorId: 1, storeConnectionId: 1 }, marketplace: {} };

    const result = await determinePriority(createService(), dropshipOrder({ rawPayload: legacyStamp }));

    expect(result).toEqual({ priority: 100, memberPlanName: null, memberPlanColor: null });
    // No plan lookup and, above all, no fallback to the buyer.
    expect(executed().filter((s) => s.text.includes("membership."))).toEqual([]);
    expect(warnings()).toEqual([{
      oms_order_id: 1013417,
      channel_id: DROPSHIP_OMS_CHANNEL_ID,
      outcome: "vendor_plan_unavailable",
      reason: "absent",
      error_code: "WMS_SYNC_DROPSHIP_VENDOR_PLAN_UNAVAILABLE",
    }]);
  });

  it("reports an unreadable plan id and scores the shipping base alone", async () => {
    answer({ planById: [OPS_PLAN_ROW] });
    const stamp = { dropship: { intakeId: 43, vendorMembershipPlanId: 100 }, marketplace: {} };

    const result = await determinePriority(createService(), dropshipOrder({ rawPayload: stamp }));

    expect(result.priority).toBe(100);
    expect(executed()).toEqual([]);
    expect(warnings()).toEqual([expect.objectContaining({ outcome: "vendor_plan_unavailable", reason: "invalid" })]);
  });

  it("scores the shipping base alone when the vendor's plan no longer exists", async () => {
    answer({ planById: [] });

    const result = await determinePriority(createService(), dropshipOrder());

    expect(result).toEqual({ priority: 100, memberPlanName: null, memberPlanColor: null });
    expect(warnings()).toEqual([{
      oms_order_id: 1013417,
      channel_id: DROPSHIP_OMS_CHANNEL_ID,
      outcome: "vendor_plan_not_found",
      plan_id: OPS_PLAN_ID,
      error_code: "WMS_SYNC_DROPSHIP_VENDOR_PLAN_NOT_FOUND",
    }]);
  });

  it("refuses a plan row whose modifier is not an integer", async () => {
    answer({ planById: [{ priority_modifier: "high", name: ".ops", primary_color: "#C060E0" }] });

    const result = await determinePriority(createService(), dropshipOrder());

    expect(result).toEqual({ priority: 100, memberPlanName: null, memberPlanColor: null });
    expect(warnings()).toEqual([expect.objectContaining({
      outcome: "vendor_plan_invalid",
      error_code: "WMS_SYNC_DROPSHIP_VENDOR_PLAN_INVALID",
    })]);
  });

  it("keeps the sync going when the plan lookup fails, and logs it", async () => {
    answer({ planById: new Error("connection terminated") });

    const result = await determinePriority(createService(), dropshipOrder());

    expect(result).toEqual({ priority: 100, memberPlanName: null, memberPlanColor: null });
    expect(warnings()).toEqual([{
      oms_order_id: 1013417,
      channel_id: DROPSHIP_OMS_CHANNEL_ID,
      outcome: "vendor_plan_lookup_failed",
      plan_id: OPS_PLAN_ID,
      error_code: "WMS_SYNC_DROPSHIP_VENDOR_PLAN_LOOKUP_FAILED",
      error: "connection terminated",
    }]);
  });
});

describe("WmsSyncService pick priority for other orders (unchanged)", () => {
  it("scores a Shopify member from their own membership", async () => {
    answer({ buyerMembership: [CLUB_PLAN_ROW] });

    const result = await determinePriority(createService(), shopifyOrder());

    expect(result).toEqual({ priority: 150, memberPlanName: ".club", memberPlanColor: "#2E86DE" });
    const [buyerQuery] = executed().filter(isBuyerMembershipQuery);
    expect(buyerQuery.params).toEqual(["member@example.com", 555]);
    expect(executed().filter(isPlanByIdQuery)).toEqual([]);
  });

  it("falls back to the order's member tier when the buyer has no subscription", async () => {
    answer({ buyerMembership: [], memberTier: [CLUB_PLAN_ROW] });

    const result = await determinePriority(createService(), shopifyOrder({ memberTier: ".club" }));

    expect(result.priority).toBe(150);
    expect(result.memberPlanName).toBe(".club");
  });

  it("scores a non-member with the shipping base alone", async () => {
    answer({});

    const result = await determinePriority(createService(), shopifyOrder());

    expect(result).toEqual({ priority: 100, memberPlanName: null, memberPlanColor: null });
    expect(warnings()).toEqual([]);
  });
});
