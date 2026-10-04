/**
 * Shared member resolver, plan step 2: the dry run beside the pick score.
 * The resolver's answer is only recorded on the new WMS order
 * (metadata.memberResolverDryRun); the score always comes from today's lookup,
 * and a dry run that fails never stops the sync.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const harness = vi.hoisted(() => ({
  database: {
    select: vi.fn(),
    execute: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  createOrderWithItems: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../../../db", () => ({ db: harness.database }));
vi.mock("../../../orders", () => ({
  ordersStorage: { createOrderWithItems: harness.createOrderWithItems },
}));
vi.mock("../../../warehouse/settings.resolver", () => ({
  getSlaCutoffConfig: async () => ({ timezone: "UTC", cutoffLocal: "12:00" }),
}));
vi.mock("../../../orders/sort-rank", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../orders/sort-rank")>()),
  resolveSlaDueAt: async () => null,
}));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: harness.debug, info: harness.info, warn: harness.warn, error: vi.fn() },
}));

import { WmsSyncService } from "../../wms-sync.service";
import {
  MemberResolver,
  MembershipResolverError,
  type MemberKey,
  type MemberResolution,
} from "../../../membership";
import type { MemberDirectory } from "../../../membership/application/member-resolver";
import type { LegacyMemberMatch, MemberResolverDryRunRecord } from "../../member-resolver-dry-run";

const SHOPIFY_CHANNEL_ID = 36;
const EBAY_CHANNEL_ID = 5;
const CLUB_PLAN_ID = "5f966934-9ff2-4966-9e8f-d4292ca3290e";

const LEGACY_CLUB_BY_EMAIL: LegacyMemberMatch = {
  outcome: "member",
  memberId: "member-club",
  planId: CLUB_PLAN_ID,
  modifier: 50,
  matchedBy: "email",
};

const RESOLVED_CLUB: MemberResolution = {
  outcome: "member",
  memberId: "member-club",
  matchedBy: "shopify_customer_id",
  subscriptionId: "sub-club",
  subscriptionStatus: "active",
  plan: { planId: CLUB_PLAN_ID, name: ".club", color: "#2E86DE", priorityModifier: 50 },
};

type ResolverDouble = { resolve: (key: MemberKey) => Promise<MemberResolution> };

function createService(memberResolver?: ResolverDouble): WmsSyncService {
  return new WmsSyncService({
    inventoryCore: {},
    reservation: {},
    fulfillmentRouter: { routeOrder: async () => null },
    dropshipOmsChannel: { resolveChannelId: async () => 103 },
    ...(memberResolver ? { memberResolver } : {}),
  } as never);
}

function runDryRun(
  service: WmsSyncService,
  omsOrder: Record<string, unknown>,
  legacy: LegacyMemberMatch,
): Promise<MemberResolverDryRunRecord | null> {
  return (service as unknown as {
    runMemberResolverDryRun(order: Record<string, unknown>, legacy: LegacyMemberMatch): Promise<MemberResolverDryRunRecord | null>;
  }).runMemberResolverDryRun(omsOrder, legacy);
}

/** The channel lookup: db.select({ provider }).from(channels).where(...).limit(1). */
function channelProviderRows(rows: Array<{ provider: string }> | Error): { where: () => SQL | undefined } {
  let where: SQL | undefined;
  harness.database.select.mockImplementation(() => {
    if (rows instanceof Error) throw rows;
    const query = {
      from: () => query,
      where: (condition: SQL) => {
        where = condition;
        return query;
      },
      limit: () => query,
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return query;
  });
  return { where: () => where };
}

/** A real resolver over a directory that must never be read. */
function resolverThatMustNotRead(): MemberResolver {
  const refuse = async (): Promise<never> => {
    throw new Error("the membership data must not be read for this order");
  };
  const directory: MemberDirectory = {
    findMemberIdsByShopifyCustomerIds: refuse,
    findMemberIdsByShopifyCustomerIdAliases: refuse,
    memberExists: refuse,
    findCurrentMemberships: refuse,
    findPlan: refuse,
  };
  return new MemberResolver(directory);
}

function dryRunLogs(level: "debug" | "info" | "warn"): Array<Record<string, unknown>> {
  return harness[level].mock.calls
    .filter(([action]) => action === "oms_member_resolver_dry_run")
    .map(([, data]) => data as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.database.select.mockReset();
  harness.database.execute.mockReset();
  harness.database.transaction.mockReset();
  harness.createOrderWithItems.mockReset();
});

describe("WmsSyncService member resolver dry run", () => {
  it("records agreement for a Shopify member and keys the lookup by the order's customer id", async () => {
    const lookup = channelProviderRows([{ provider: "shopify" }]);
    const resolve = vi.fn(async (_key: MemberKey) => RESOLVED_CLUB);

    const record = await runDryRun(createService({ resolve }), {
      id: 2001,
      channelId: SHOPIFY_CHANNEL_ID,
      externalCustomerId: "gid://shopify/Customer/555",
    }, LEGACY_CLUB_BY_EMAIL);

    expect(resolve).toHaveBeenCalledWith({ kind: "shopify_customer", shopifyCustomerId: "555" });
    expect(record).toMatchObject({
      channelId: SHOPIFY_CHANNEL_ID,
      channelProvider: "shopify",
      key: { kind: "shopify_customer", reason: null },
      agrees: true,
      modifierDelta: 0,
    });
    const where = new PgDialect().sqlToQuery(lookup.where()!);
    expect(where.params).toEqual([SHOPIFY_CHANNEL_ID]);
    expect(dryRunLogs("debug")).toEqual([]);
    expect(dryRunLogs("info")).toEqual([]);
    expect(dryRunLogs("warn")).toEqual([]);
  });

  it("records the eBay buyer whose email matches a member, without reading membership data", async () => {
    channelProviderRows([{ provider: "ebay" }]);

    const record = await runDryRun(createService(resolverThatMustNotRead()), {
      id: 3001,
      channelId: EBAY_CHANNEL_ID,
      externalCustomerId: "ebay-buyer-username",
    }, LEGACY_CLUB_BY_EMAIL);

    expect(record).toMatchObject({
      channelProvider: "ebay",
      key: { kind: "none", reason: "channel_without_membership" },
      resolver: { outcome: "not_applicable", planId: null, modifier: 0 },
      agrees: false,
      modifierDelta: -50,
    });
    expect(dryRunLogs("debug")).toEqual([{
      oms_order_id: 3001,
      channel_id: EBAY_CHANNEL_ID,
      outcome: "disagreed",
      before: record!.legacy,
      after: record!.resolver,
    }]);
    expect(dryRunLogs("info")).toEqual([]);
  });

  it("records a resolver failure with its code and keeps the comparison open", async () => {
    channelProviderRows([{ provider: "shopify" }]);
    const resolve = vi.fn(async (): Promise<MemberResolution> => {
      throw new MembershipResolverError("MEMBERSHIP_CURRENT_MEMBERSHIP_NOT_UNIQUE", "two current rows", "permanent", {});
    });

    const record = await runDryRun(createService({ resolve }), {
      id: 2001,
      channelId: SHOPIFY_CHANNEL_ID,
      externalCustomerId: "555",
    }, LEGACY_CLUB_BY_EMAIL);

    expect(record).toMatchObject({
      resolver: { outcome: "resolver_failed", errorCode: "MEMBERSHIP_CURRENT_MEMBERSHIP_NOT_UNIQUE" },
      agrees: null,
      modifierDelta: null,
    });
    expect(dryRunLogs("warn")).toEqual([{
      oms_order_id: 2001,
      channel_id: SHOPIFY_CHANNEL_ID,
      outcome: "resolver_failed",
      error_code: "MEMBERSHIP_CURRENT_MEMBERSHIP_NOT_UNIQUE",
      error: "two current rows",
    }]);
  });

  it("names an unclassified resolver failure a lookup failure", async () => {
    channelProviderRows([{ provider: "shopify" }]);
    const resolve = vi.fn(async (): Promise<MemberResolution> => {
      throw new Error("socket hang up");
    });

    const record = await runDryRun(createService({ resolve }), {
      id: 2001,
      channelId: SHOPIFY_CHANNEL_ID,
      externalCustomerId: "555",
    }, LEGACY_CLUB_BY_EMAIL);

    expect(record?.resolver).toMatchObject({ outcome: "resolver_failed", errorCode: "MEMBERSHIP_LOOKUP_FAILED" });
  });

  it("skips the dry run when no resolver is wired", async () => {
    const record = await runDryRun(createService(), { id: 2001, channelId: SHOPIFY_CHANNEL_ID }, LEGACY_CLUB_BY_EMAIL);

    expect(record).toBeNull();
    expect(harness.database.select).not.toHaveBeenCalled();
  });

  it("drops the dry run, never the sync, when the channel cannot be read", async () => {
    channelProviderRows(new Error("connection terminated"));
    const resolve = vi.fn(async () => RESOLVED_CLUB);

    const record = await runDryRun(createService({ resolve }), {
      id: 2001,
      channelId: SHOPIFY_CHANNEL_ID,
      externalCustomerId: "555",
    }, LEGACY_CLUB_BY_EMAIL);

    expect(record).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(dryRunLogs("warn")).toEqual([{
      oms_order_id: 2001,
      channel_id: SHOPIFY_CHANNEL_ID,
      outcome: "dry_run_failed",
      error_code: "OMS_MEMBER_RESOLVER_DRY_RUN_FAILED",
      error: "connection terminated",
    }]);
  });

  it("treats an order without a channel as one without membership", async () => {
    const resolve = vi.fn(async (key: MemberKey): Promise<MemberResolution> =>
      key.kind === "none" ? { outcome: "not_applicable", reason: key.reason } : RESOLVED_CLUB);

    const record = await runDryRun(createService({ resolve }), { id: 2001, channelId: null }, { outcome: "no_member" });

    expect(harness.database.select).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({ kind: "none", reason: "channel_without_membership" });
    expect(record).toMatchObject({ channelId: null, channelProvider: null, agrees: true });
  });
});

describe("WmsSyncService keeps the dry run on the new WMS order only", () => {
  const RECORD = { version: 1, agrees: true } as unknown as MemberResolverDryRunRecord;

  /** Same scripted reads as the country-boundary sync test: order, lines, materialization. */
  function scriptOrderReads(): void {
    const reads: unknown[][] = [
      [{
        id: 10,
        channelId: SHOPIFY_CHANNEL_ID,
        status: "confirmed",
        financialStatus: "paid",
        externalOrderId: "1001",
        shipToCountry: "US",
        subtotalCents: 100,
        totalCents: 100,
        currency: "USD",
        orderedAt: new Date("2026-09-01T12:00:00.000Z"),
      }],
      [],
      [{
        id: 20,
        quantity: 1,
        authorityFulfillableQuantity: 1,
        wmsMaterializedQuantity: 0,
        requiresShipping: false,
        paidPriceCents: 100,
        totalPriceCents: 100,
        productVariantId: null,
      }],
      [],
    ];
    harness.database.select.mockImplementation(() => {
      const result = reads.shift() ?? [];
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
      };
      return query;
    });
    harness.database.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 20,
          quantity: 1,
          authority_fulfillable_quantity: 1,
          wms_materialized_quantity: 0,
          requires_shipping: false,
          paid_price_cents: 100,
          total_price_cents: 100,
        }],
      });
    harness.database.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(harness.database));
  }

  async function syncCapturingWmsOrder(input: {
    legacyMember: LegacyMemberMatch | null;
    record: MemberResolverDryRunRecord | null;
  }) {
    scriptOrderReads();
    const reachedStorage = new Error("captured WMS write boundary");
    harness.createOrderWithItems.mockRejectedValue(reachedStorage);
    const service = createService({ resolve: async () => RESOLVED_CLUB });
    vi.spyOn(service as unknown as { determinePriority: () => Promise<unknown> }, "determinePriority")
      .mockResolvedValue({ priority: 150, memberPlanName: ".club", memberPlanColor: "#2E86DE", legacyMember: input.legacyMember });
    const dryRun = vi.spyOn(
      service as unknown as { runMemberResolverDryRun: () => Promise<MemberResolverDryRunRecord | null> },
      "runMemberResolverDryRun",
    ).mockResolvedValue(input.record);

    await expect(service.syncOmsOrderToWms(10)).rejects.toBe(reachedStorage);
    expect(harness.createOrderWithItems).toHaveBeenCalledOnce();
    return { wmsOrder: harness.createOrderWithItems.mock.calls[0][0] as Record<string, unknown>, dryRun };
  }

  it("stores the comparison under metadata.memberResolverDryRun and scores from today's lookup", async () => {
    const { wmsOrder, dryRun } = await syncCapturingWmsOrder({ legacyMember: LEGACY_CLUB_BY_EMAIL, record: RECORD });

    expect(dryRun).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }), LEGACY_CLUB_BY_EMAIL);
    expect(wmsOrder.metadata).toEqual({ memberResolverDryRun: RECORD });
    expect(wmsOrder.priority).toBe(150);
    expect(wmsOrder.memberPlanName).toBe(".club");
  });

  it("writes no metadata when there is nothing to compare (Dropship path)", async () => {
    const { wmsOrder, dryRun } = await syncCapturingWmsOrder({ legacyMember: null, record: RECORD });

    expect(dryRun).not.toHaveBeenCalled();
    expect("metadata" in wmsOrder).toBe(false);
  });

  it("writes no metadata when the dry run produced no record", async () => {
    const { wmsOrder } = await syncCapturingWmsOrder({ legacyMember: LEGACY_CLUB_BY_EMAIL, record: null });

    expect("metadata" in wmsOrder).toBe(false);
  });
});
