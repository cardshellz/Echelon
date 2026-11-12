import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  txMock,
  dbMock,
  auditLogMock,
  withAdvisoryLockMock,
  shopifyGraphQLMock,
} = vi.hoisted(() => {
  const txObj = {
    __isTx: true,
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  };
  const dbObj = {
    __isGlobalDb: true,
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(async (cb: (tx: typeof txObj) => Promise<unknown>) => cb(txObj)),
  };
  return {
    txMock: txObj,
    dbMock: dbObj,
    auditLogMock: vi.fn(),
    withAdvisoryLockMock: vi.fn(),
    shopifyGraphQLMock: vi.fn(),
  };
});

vi.mock("../../../../db", () => ({
  db: dbMock,
}));

vi.mock("../../../../infrastructure/auditLogger", () => ({
  AuditLogger: {
    log: auditLogMock,
  },
}));

vi.mock("../../../../infrastructure/scheduler-lock", () => ({
  withAdvisoryLock: withAdvisoryLockMock,
}));

vi.mock("../../../shopify/admin-gql-client", () => ({
  shopifyGraphQL: shopifyGraphQLMock,
}));

import * as storage from "../../infrastructure/subscription.repository";
import * as shopifyAdapter from "../../infrastructure/shopify.adapter";
import * as useCases from "../../application/subscription.use-cases";
import { processDueBillings, runBillingPassWithLock } from "../../subscription.scheduler";
import { registerSubscriptionWebhookRoutes } from "../../subscription.webhooks";

describe("Priority 13 Batch CUST-1 — Subscription Safeguards (CUST-02, CUST-03, CUST-05)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    storage.resetCurrentMembershipRelationCacheForTests();
    dbMock.transaction.mockImplementation(async (cb: (tx: typeof txMock) => Promise<unknown>) =>
      cb(txMock),
    );
  });

  describe("CUST-02: Repository executor binding & null-safe billing log", () => {
    it("passes the active transaction executor `tx` to every storage write in processContractCreatedUseCase and aborts atomically on mid-tx failure", async () => {
      vi.spyOn(storage, "findSubscriptionByContractId").mockResolvedValue(null);
      vi.spyOn(shopifyAdapter, "fetchContractSellingPlanLines").mockResolvedValue({
        sellingPlanGid: "gid://shopify/SellingPlan/11",
        productId: "gid://shopify/Product/22",
      });
      const plan = {
        id: 2,
        name: "Gold Monthly",
        billing_interval: "month",
        billing_interval_count: 1,
        price_cents: 1999,
        shopify_product_id: "gid://shopify/Product/22",
        shopify_selling_plan_gid: "gid://shopify/SellingPlan/11",
        includes_dropship: true,
        is_active: true,
        priority_modifier: 10,
      };
      vi.spyOn(storage, "getPlanBySellingPlanGid").mockResolvedValue(plan);
      vi.spyOn(storage, "getActivePlans").mockResolvedValue([plan]);
      vi.spyOn(shopifyAdapter, "getShopifyCustomer").mockResolvedValue({
        email: "member@example.com",
        firstName: "Alex",
        lastName: "Rivera",
      });

      const upsertMemberSpy = vi.spyOn(storage, "upsertMember").mockResolvedValue(101);
      const createSubSpy = vi.spyOn(storage, "createSubscription").mockResolvedValue(501);
      const upsertCurrentSpy = vi.spyOn(storage, "upsertCurrentMembership").mockResolvedValue();
      const insertEventSpy = vi
        .spyOn(storage, "insertEvent")
        .mockRejectedValueOnce(new Error("simulated event write failure"));

      let rolledBack = false;
      dbMock.transaction.mockImplementationOnce(async (cb) => {
        try {
          return await cb(txMock);
        } catch (err) {
          rolledBack = true;
          throw err;
        }
      });

      await expect(
        useCases.processContractCreatedUseCase({
          id: 9001,
          admin_graphql_api_id: "gid://shopify/SubscriptionContract/9001",
          customer_id: 777,
          admin_graphql_api_customer_id: "gid://shopify/Customer/777",
          status: "ACTIVE",
          billing_policy: { interval: "MONTH", interval_count: 1 },
        } as any),
      ).rejects.toThrow("simulated event write failure");

      expect(rolledBack).toBe(true);
      expect(upsertMemberSpy).toHaveBeenCalledWith(expect.any(Object), txMock);
      expect(createSubSpy).toHaveBeenCalledWith(expect.any(Object), txMock);
      expect(upsertCurrentSpy).toHaveBeenCalledWith(101, 2, "Gold Monthly", txMock);
      expect(insertEventSpy).toHaveBeenCalledWith(expect.any(Object), txMock);
    });

    it("passes `tx` to all writes in processBillingSuccessUseCase, processBillingFailureUseCase, changePlanUseCase, pauseSubscriptionUseCase, and updatePlanDetailsUseCase", async () => {
      const subRecord = {
        id: 55,
        member_id: 12,
        plan_id: 1,
        status: "active",
        billing_status: "current",
        shopify_subscription_contract_id: 8801,
        shopify_subscription_contract_gid: "gid://shopify/SubscriptionContract/8801",
        plan_name: "Standard",
        price_cents: 999,
      };
      const planRecord = {
        id: 2,
        name: "Gold",
        billing_interval: "month",
        billing_interval_count: 1,
        price_cents: 1999,
        shopify_product_id: null,
        shopify_selling_plan_gid: null,
        includes_dropship: true,
        is_active: true,
        priority_modifier: 10,
      };

      vi.spyOn(storage, "findSubscriptionByContractId").mockResolvedValue(subRecord as any);
      vi.spyOn(storage, "getSubscriptionDetail").mockResolvedValue(subRecord as any);
      vi.spyOn(storage, "getPlanById").mockResolvedValue(planRecord);

      const updateBillingDateSpy = vi.spyOn(storage, "updateSubscriptionBillingDate").mockResolvedValue();
      const insertBillingLogSpy = vi.spyOn(storage, "insertBillingLog").mockResolvedValue(1);
      const insertEventSpy = vi.spyOn(storage, "insertEvent").mockResolvedValue();
      const incFailedSpy = vi.spyOn(storage, "incrementFailedBilling").mockResolvedValue(1);
      const setNextBillingSpy = vi.spyOn(storage, "setNextBillingDate").mockResolvedValue();
      const updatePlanSpy = vi.spyOn(storage, "updateSubscriptionPlan").mockResolvedValue();
      const upsertCurrentSpy = vi.spyOn(storage, "upsertCurrentMembership").mockResolvedValue();
      const updateStatusSpy = vi.spyOn(storage, "updateSubscriptionStatus").mockResolvedValue();
      const hasOtherActiveSpy = vi.spyOn(storage, "hasOtherActiveSubscription").mockResolvedValue(false);
      const clearCurrentSpy = vi.spyOn(storage, "clearCurrentMembership").mockResolvedValue();
      const updatePlanDetailsSpy = vi.spyOn(storage, "updatePlanDetails").mockResolvedValue();

      await useCases.processBillingSuccessUseCase({
        subscription_contract_id: 8801,
        id: "att-1",
        order_id: null,
      } as any);
      expect(updateBillingDateSpy).toHaveBeenCalledWith(
        55,
        expect.any(Date),
        expect.any(Date),
        expect.any(Date),
        txMock,
      );
      expect(insertBillingLogSpy).toHaveBeenCalledWith(
        expect.objectContaining({ shopify_order_id: null }),
        txMock,
      );

      await useCases.processBillingFailureUseCase({
        subscription_contract_id: 8801,
        id: "att-2",
        error_code: "CARD_DECLINED",
        error_message: "Card declined",
      } as any);
      expect(incFailedSpy).toHaveBeenCalledWith(55, txMock);
      expect(setNextBillingSpy).toHaveBeenCalledWith(55, expect.any(Date), txMock);

      await useCases.changePlanUseCase(55, 2, "alice");
      expect(updatePlanSpy).toHaveBeenCalledWith(55, 2, txMock);
      expect(upsertCurrentSpy).toHaveBeenCalledWith(12, 2, "Gold", txMock);
      expect(auditLogMock).toHaveBeenCalledWith(expect.objectContaining({ actor: "alice" }));

      await useCases.pauseSubscriptionUseCase(55, true, "bob");
      expect(updateStatusSpy).toHaveBeenCalledWith(55, "paused", "paused", undefined, txMock);
      expect(hasOtherActiveSpy).toHaveBeenCalledWith(12, 55, txMock);
      expect(clearCurrentSpy).toHaveBeenCalledWith(12, txMock);
      expect(auditLogMock).toHaveBeenCalledWith(expect.objectContaining({ actor: "bob" }));

      await useCases.updatePlanDetailsUseCase(2, { price_cents: 2499 }, "carol");
      expect(updatePlanDetailsSpy).toHaveBeenCalledWith(2, { price_cents: 2499 }, txMock);
      expect(insertEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: "plan_updated" }),
        txMock,
      );
      expect(auditLogMock).toHaveBeenCalledWith(
        expect.objectContaining({ actor: "carol", action: "update_subscription_plan" }),
      );
    });

    it("stores null rather than literal 'undefined' when insertBillingLog omits shopify_order_id", async () => {
      let insertedValues: Record<string, unknown> | null = null;
      const returningMock = vi.fn().mockResolvedValue([{ id: "77" }]);
      const valuesMock = vi.fn((vals: Record<string, unknown>) => {
        insertedValues = vals;
        return { returning: returningMock };
      });
      const customExecutor = {
        ...txMock,
        insert: vi.fn(() => ({ values: valuesMock })),
      };

      const logId = await storage.insertBillingLog(
        {
          member_subscription_id: 55,
          amount_cents: 1999,
          status: "pending",
        },
        customExecutor as any,
      );

      expect(logId).toBe(77);
      expect(insertedValues).not.toBeNull();
      expect(insertedValues!.shopifyOrderId).toBeNull();
    });
  });

  describe("CUST-03 & CUST-05: Remote command verification, atomic billing claims & lock safety", () => {
    it("checks userErrors across draft create, update, and commit in cancelShopifyContract", async () => {
      shopifyGraphQLMock
        .mockResolvedValueOnce({
          subscriptionDraftCreate: { draft: { id: "gid://shopify/SubscriptionDraft/1" }, userErrors: [] },
        })
        .mockResolvedValueOnce({
          subscriptionDraftUpdate: { draft: { id: "gid://shopify/SubscriptionDraft/1" }, userErrors: [] },
        })
        .mockResolvedValueOnce({
          subscriptionDraftCommit: {
            contract: null,
            userErrors: [{ message: "Contract is already cancelled" }],
          },
        });

      await expect(
        shopifyAdapter.cancelShopifyContract("gid://shopify/SubscriptionContract/8801"),
      ).rejects.toThrow("Failed to commit draft: Contract is already cancelled");
    });

    it("surfaces providerStatus = 'provider_failed' and records a durable reconciliation event when remote cancel fails", async () => {
      vi.spyOn(storage, "getSubscriptionDetail").mockResolvedValue({
        id: "55",
        member_id: "12",
        plan_id: "2",
        status: "active",
        billing_status: "current",
        shopify_subscription_contract_id: 8801,
        shopify_subscription_contract_gid: "gid://shopify/SubscriptionContract/8801",
      });
      vi.spyOn(storage, "updateSubscriptionStatus").mockResolvedValue();
      vi.spyOn(storage, "hasOtherActiveSubscription").mockResolvedValue(false);
      vi.spyOn(storage, "clearCurrentMembership").mockResolvedValue();
      const insertEventSpy = vi.spyOn(storage, "insertEvent").mockResolvedValue();
      vi.spyOn(shopifyAdapter, "cancelShopifyContract").mockRejectedValue(
        new Error("Shopify GraphQL error 503: Service Unavailable"),
      );

      const res = await useCases.cancelSubscriptionUseCase(55, "Customer requested", "dana");

      expect(res.success).toBe(true);
      expect(res.providerStatus).toBe("provider_failed");
      expect(res.warning).toContain("remote Shopify contract cancellation could not be confirmed");
      expect(insertEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          member_subscription_id: 55,
          event_type: "provider_cancel_failed",
          payload: expect.objectContaining({
            actor: "dana",
            uncertain: true,
          }),
        }),
      );
      expect(auditLogMock).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "dana",
          action: "cancel_subscription",
        }),
      );
    });

    it("guards retryBillingUseCase with atomic claim, deterministic cycle key, and preserves billing_in_progress on uncertain errors", async () => {
      const detail = {
        id: "55",
        member_id: "12",
        plan_id: "2",
        status: "active",
        billing_status: "past_due",
        next_billing_date: new Date("2026-11-15T00:00:00.000Z"),
        failed_billing_attempts: 2,
        price_cents: 1999,
        shopify_subscription_contract_id: 8801,
        shopify_subscription_contract_gid: "gid://shopify/SubscriptionContract/8801",
      };
      vi.spyOn(storage, "getSubscriptionDetail").mockResolvedValue(detail);

      // 1) Already claimed -> rejected without touching setBillingInProgress(false) or provider
      const claimSpy = vi.spyOn(storage, "claimBillingInProgress").mockResolvedValueOnce(false);
      const setInProgressSpy = vi.spyOn(storage, "setBillingInProgress").mockResolvedValue();
      const createAttemptSpy = vi.spyOn(shopifyAdapter, "createBillingAttempt");

      const busyRes = await useCases.retryBillingUseCase(55, "erin");
      expect(busyRes).toMatchObject({
        success: false,
        code: "BILLING_ALREADY_IN_PROGRESS",
      });
      expect(createAttemptSpy).not.toHaveBeenCalled();
      expect(setInProgressSpy).not.toHaveBeenCalled();

      // 2) Uncertain transport timeout -> billing_in_progress stays TRUE!
      claimSpy.mockResolvedValueOnce(true);
      vi.spyOn(storage, "insertBillingLog").mockResolvedValue(10);
      const eventSpy = vi.spyOn(storage, "insertEvent").mockResolvedValue();
      createAttemptSpy.mockRejectedValueOnce(new Error("fetch failed: socket hang up"));

      const uncertainRes = await useCases.retryBillingUseCase(55, "erin");
      expect(uncertainRes).toMatchObject({
        success: false,
        uncertain: true,
        code: "BILLING_OUTCOME_UNCERTAIN",
      });
      expect(createAttemptSpy).toHaveBeenCalledWith(
        "gid://shopify/SubscriptionContract/8801",
        "billing-8801-retry-2026-11-15-a2",
        "2026-11-15T00:00:00.000Z",
      );
      expect(setInProgressSpy).not.toHaveBeenCalled();
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: "billing_retry_uncertain" }),
        txMock,
      );

      // 3) Definitive provider rejection -> billing_in_progress IS cleared to false
      claimSpy.mockResolvedValueOnce(true);
      createAttemptSpy.mockRejectedValueOnce(
        new shopifyAdapter.SubscriptionProviderRejectedError("Payment method revoked"),
      );

      const rejectedRes = await useCases.retryBillingUseCase(55, "erin");
      expect(rejectedRes).toMatchObject({
        success: false,
        code: "PROVIDER_REJECTED",
      });
      expect(setInProgressSpy).toHaveBeenCalledWith(55, false, txMock);
    });

    it("skips manual/scheduled billing pass when advisory lock is held and preserves lock on uncertain scheduler errors", async () => {
      withAdvisoryLockMock.mockResolvedValueOnce(null);
      const lockedRun = await runBillingPassWithLock();
      expect(lockedRun).toEqual({
        skipped: true,
        reason: "billing_lock_held",
        processed: 0,
        succeeded: 0,
        failed: 0,
        uncertain: 0,
        errors: [],
      });

      vi.spyOn(storage, "reconcileCurrentMemberships").mockResolvedValue({ upserted: 1 });
      vi.spyOn(storage, "getDueBillings").mockResolvedValue([
        {
          id: 91,
          shopify_subscription_contract_id: 9101,
          shopify_subscription_contract_gid: "gid://shopify/SubscriptionContract/9101",
          next_billing_date: new Date("2026-11-11T00:00:00.000Z"),
          price_cents: 999,
        } as any,
        {
          id: 92,
          shopify_subscription_contract_id: 9102,
          shopify_subscription_contract_gid: "gid://shopify/SubscriptionContract/9102",
          next_billing_date: new Date("2026-11-11T00:00:00.000Z"),
          price_cents: 999,
        } as any,
      ]);
      vi.spyOn(storage, "claimBillingInProgress").mockResolvedValue(true);
      const setInProgressSpy = vi.spyOn(storage, "setBillingInProgress").mockResolvedValue();
      vi.spyOn(storage, "insertBillingLog").mockResolvedValue(1);
      vi.spyOn(storage, "insertEvent").mockResolvedValue();
      shopifyGraphQLMock
        // sub 91 -> uncertain HTTP 502
        .mockRejectedValueOnce(new Error("Shopify GraphQL error 502: Bad Gateway"))
        // sub 92 -> definitive userErrors rejection
        .mockResolvedValueOnce({
          subscriptionBillingAttemptCreate: {
            subscriptionBillingAttempt: null,
            userErrors: [{ message: "Contract paused" }],
          },
        });

      const summary = await processDueBillings({ batchDelayMs: 0 });
      expect(summary).toMatchObject({
        processed: 2,
        succeeded: 0,
        failed: 1,
        uncertain: 1,
      });
      // Only sub 92 (definitive rejection) cleared billing_in_progress; sub 91 kept it locked!
      expect(setInProgressSpy).toHaveBeenCalledTimes(1);
      expect(setInProgressSpy).toHaveBeenCalledWith(92, false, txMock);
    });

    it("logs disabled webhook ownership honestly instead of claiming webhook routes were registered (CUST-05)", () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      registerSubscriptionWebhookRoutes({ post: vi.fn() } as any);

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("disabled in Echelon (owned by shellz-club-app)"),
      );
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Subscription webhook routes registered"),
      );
    });
  });
});
