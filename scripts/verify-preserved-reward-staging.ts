/**
 * Explicit acceptance against synthetic resources in the Shopify TEST store.
 * Runs the real provider through preview, quote, commit, reconciliation and
 * unpaid recovery. Uses a test store catalog variant and cancels/restocks fixtures.
 * No live customer, order or points are modified.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { ShopifyOrderEditProvider } from "../server/modules/order-edits/infrastructure/shopify-order-edit.provider";
import { PostgresOrderEditCodeHistory } from "../server/modules/order-edits/infrastructure/postgres-order-edit-code-history";
import type { OrderEditQuote } from "../server/modules/order-edits/application/order-edit-provider";
import {
  presentOrderEditCodeBreakdown,
  quoteProductPrices,
} from "../server/modules/order-edits/application/order-edit-code-presentation";

const shop = process.env.REWARDS_STAGING_SHOP;
assert.equal(shop, "cardshellz-staging.myshopify.com");
const token = process.env.REWARDS_STAGING_TOKEN;
assert.ok(token);
const fixture = `reward-edit-${randomUUID().slice(0, 20)}`;
const stackSavedReward = process.env.REWARDS_STAGING_STACK === "true";
const receiptUrl = process.env.REWARDS_STAGING_RECEIPTS_URL;
if (stackSavedReward) {
  assert.ok(receiptUrl);
  assert.equal(new URL(receiptUrl).hostname, "127.0.0.1");
  assert.equal(process.env.ECHELON_TEST_DATABASE_DISPOSABLE, "true");
  assert.ok(process.env.REWARDS_STAGING_TEST_KEY);
}
async function receipt<T = unknown>(path: string, body: unknown): Promise<T> {
  assert.ok(stackSavedReward && receiptUrl);
  const response = await fetch(`${receiptUrl}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Key": process.env.REWARDS_STAGING_TEST_KEY!,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result as T;
}
const inventoryRecoveryKey = randomUUID();
const originalVariant = "gid://shopify/ProductVariant/45456261873862";
let testInventory: { inventoryItemId: string; locationId: string } | undefined;
const cleanup: Array<{
  kind: "customer" | "code" | "draft" | "order";
  id: string;
}> = [];
const report: Record<string, unknown> = {
  fixture,
  shop,
  startedAt: new Date().toISOString(),
  realOrdersChanged: 0,
  realPointsChanged: 0,
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  inventoryRecoveryKey,
};
async function request<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(
    `https://${shop}/admin/api/2026-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token!,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const body = await response.json();
  assert.equal(response.ok, true, `Shopify returned HTTP ${response.status}`);
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data;
}
type Result<T> = T & { userErrors: Array<{ message: string }> };
function result<T>(value: Result<T>): T {
  assert.deepEqual(value.userErrors, []);
  return value;
}
async function main(): Promise<void> {
  try {
    // Existing Shopify sample catalog product; cleanup cancels and restocks the
    // synthetic order before deletion. Its product definition is never changed.
    const addedVariant = originalVariant;
    const variant = (
      await request<{
        productVariant: {
          price: string;
          inventoryQuantity: number;
          inventoryItem: {
            id: string;
            tracked: boolean;
            requiresShipping: boolean;
            inventoryLevels: { nodes: Array<{ location: { id: string } }> };
          };
        };
      }>(
        `query($id:ID!){productVariant(id:$id){price inventoryQuantity inventoryItem{
        id tracked requiresShipping inventoryLevels(first:2){nodes{location{id}}}}}}`,
        { id: originalVariant },
      )
    ).productVariant;
    assert.equal(variant.price, "885.95");
    assert.ok(variant.inventoryQuantity >= 3);
    assert.equal(variant.inventoryItem.requiresShipping, true);
    assert.equal(variant.inventoryItem.tracked, true);
    assert.equal(variant.inventoryItem.inventoryLevels.nodes.length, 1);
    testInventory = {
      inventoryItemId: variant.inventoryItem.id,
      locationId: variant.inventoryItem.inventoryLevels.nodes[0].location.id,
    };
    report.inventoryBefore = variant.inventoryQuantity;
    const customer = result(
      (
        await request<{ customerCreate: Result<{ customer: { id: string } }> }>(
          `mutation($input:CustomerInput!){customerCreate(input:$input){customer{id}userErrors{message}}}`,
          {
            input: {
              firstName: "Synthetic",
              lastName: fixture,
              tags: [fixture],
            },
          },
        )
      ).customerCreate,
    ).customer;
    cleanup.push({ kind: "customer", id: customer.id });
    const code = result(
      (
        await request<{
          discountCodeBasicCreate: Result<{ codeDiscountNode: { id: string } }>;
        }>(
          `mutation($input:DiscountCodeBasicInput!){discountCodeBasicCreate(basicCodeDiscount:$input){codeDiscountNode{id}userErrors{message}}}`,
          {
            input: {
              title: fixture,
              code: fixture,
              startsAt: new Date().toISOString(),
              usageLimit: 1,
              appliesOncePerCustomer: true,
              customerSelection: { all: true },
              combinesWith: {
                orderDiscounts: true,
                productDiscounts: true,
                shippingDiscounts: true,
              },
              customerGets: {
                value: {
                  discountAmount: { amount: "7.23", appliesOnEachItem: false },
                },
                items: { all: true },
              },
            },
          },
        )
      ).discountCodeBasicCreate,
    );
    cleanup.push({ kind: "code", id: code.codeDiscountNode.id });
    const shippingAddress = {
      firstName: "Synthetic",
      lastName: "Acceptance",
      address1: "1 Main Street",
      city: "Pittsburgh",
      provinceCode: "PA",
      countryCode: "US",
      zip: "15222",
    };
    const lineItems = [
      {
        variantId: originalVariant,
        quantity: 1,
        priceOverride: { amount: "2.79", currencyCode: "USD" },
      },
    ];
    const rates = (
      await request<{
        draftOrderAvailableDeliveryOptions: {
          availableShippingRates: Array<{ handle: string; title: string }>;
        };
      }>(
        `query($input:DraftOrderAvailableDeliveryOptionsInput!){
    draftOrderAvailableDeliveryOptions(input:$input){availableShippingRates{handle title}}}`,
        {
          input: {
            lineItems,
            shippingAddress,
            purchasingEntity: { customerId: customer.id },
            discountCodes: [fixture],
            acceptAutomaticDiscounts: false,
          },
        },
      )
    ).draftOrderAvailableDeliveryOptions.availableShippingRates;
    assert.ok(
      rates.length,
      "The test store must offer a delivery service to this fixture.",
    );
    report.deliveryService = rates[0].title;
    const draft = result(
      (
        await request<{
          draftOrderCreate: Result<{ draftOrder: { id: string } }>;
        }>(
          `mutation($input:DraftOrderInput!){draftOrderCreate(input:$input){draftOrder{id}userErrors{message}}}`,
          {
            input: {
              note: fixture,
              tags: [fixture],
              visibleToCustomer: false,
              acceptAutomaticDiscounts: false,
              customerId: customer.id,
              customAttributes: [
                { key: "csz_suppress_member_pricing", value: "true" },
              ],
              lineItems,
              discountCodes: [fixture],
              shippingAddress,
              shippingLine: { shippingRateHandle: rates[0].handle },
            },
          },
        )
      ).draftOrderCreate,
    );
    cleanup.push({ kind: "draft", id: draft.draftOrder.id });
    const order = result(
      (
        await request<{
          draftOrderComplete: Result<{
            draftOrder: { order: { id: string; name: string } };
          }>;
        }>(
          `mutation($id:ID!){draftOrderComplete(id:$id,paymentPending:false){draftOrder{order{id name}}userErrors{message}}}`,
          { id: draft.draftOrder.id },
        )
      ).draftOrderComplete,
    ).draftOrder.order;
    cleanup.push({ kind: "order", id: order.id });
    report.order = order;
    await writeFile(
      ".codex-artifacts/preserved-reward-staging.json",
      JSON.stringify({ ...report, cleanup }, null, 2),
    );
    const savedReward = stackSavedReward
      ? await receipt<{ code: string; discountId: string }>("setup", {
          customerId: customer.id,
          orderId: order.id,
          originalCode: fixture.toUpperCase(),
          originalDiscountId: code.codeDiscountNode.id,
        })
      : undefined;
    if (savedReward) cleanup.push({ kind: "code", id: savedReward.discountId });
    const quotes: OrderEditQuote[] = [];
    const provider = new ShopifyOrderEditProvider({
      ...(stackSavedReward
        ? {
            fetch: async (url: string | URL | Request, init?: RequestInit) => {
              const response = await fetch(url, init);
              const input = JSON.parse(String(init?.body));
              if (input.query.includes("query EchelonEditOrder(")) {
                const result = await response.clone().json();
                report.lastNativeOrder = result.data?.order;
              }
              return response;
            },
          }
        : {}),
      credentials: {
        get: async () => ({
          connectionId: 1,
          channelId: 1,
          shopDomain: shop!,
          accessToken: token!,
        }),
      },
      clock: () => new Date(),
      report: (event) =>
        console.log(JSON.stringify({ phase: event.phase, code: event.code })),
      ...(savedReward
        ? {
            rewards: {
              available: () => true,
              identify: async (input: {
                customerId: string;
                codes: string[];
              }) =>
                (await receipt<{ codes: string[] }>("identify", input)).codes,
              verify: async (input: unknown) => {
                await receipt("validate", input);
              },
            },
            codeHistory: new PostgresOrderEditCodeHistory({
              query: async () => ({
                rows: [...quotes].reverse().map((quote) => ({ quote })),
              }),
            } as unknown as import("pg").Pool),
          }
        : {}),
    });
    const before = await provider.readOrder(1, order.id);
    assert.equal(before.subtotalCents, 0);
    assert.equal(before.nativeDiscountAllocations?.[0]?.amountCents, 279);
    if (savedReward) {
      const plan = {
        changes: [{ lineItemId: before.lines[0].id, quantity: 2 }],
        additions: [],
        discountCodes: [savedReward.code],
      };
      const preview = await provider.preview(
        await provider.preparePreview(before),
        plan,
      );
      const prepare = async (snapshot: typeof before) => {
        const quote = await provider.quote(1, snapshot, plan, randomUUID());
        quotes.push(quote);
        assert.equal(quote.financials!.itemsNetCents, 88362);
        assert.equal(
          quote.codePricing!.retainedNativeDiscounts![0].amountCents,
          279,
        );
        assert.deepEqual(quote.codePricing!.applications, [
          { code: savedReward.code, amountCents: 233 },
        ]);
        await receipt("intent", { quote });
        return quote;
      };
      const failed = await prepare(before);
      assert.equal(preview.financials.totalCents, failed.totalCents);
      await assert.rejects(
        provider.commit(1, failed, failed.operationId, async () => {
          await receipt("reserve-lost-response", {
            operationId: failed.operationId,
          });
        }),
      );
      assert.equal(
        (await provider.readOrder(1, order.id)).fingerprint,
        before.fingerprint,
      );
      await receipt("not-submitted", { operationId: failed.operationId });
      const quote = await prepare(before);
      const unpaid = await provider.commit(
        1,
        quote,
        quote.operationId,
        async () => {
          await receipt("reserve", { operationId: quote.operationId });
        },
      );
      assert.ok(unpaid.outstandingCents > 0);
      await receipt("unpaid", {
        operationId: quote.operationId,
        snapshot: unpaid,
      });
      const recoveryId = randomUUID();
      const restored = await provider.recoverUnpaid(
        1,
        before,
        quote,
        recoveryId,
      );
      assert.equal(
        (await provider.reconcileRecovery(1, before, recoveryId, quote)).status,
        "restored",
      );
      await receipt("recovered", {
        operationId: quote.operationId,
        snapshot: restored,
      });
      const retry = await prepare(restored);
      await provider.commit(1, retry, retry.operationId, async () => {
        await receipt("reserve", { operationId: retry.operationId });
      });
      result(
        (
          await request<{ orderMarkAsPaid: Result<unknown> }>(
            `mutation($input:OrderMarkAsPaidInput!){orderMarkAsPaid(input:$input){userErrors{message}}}`,
            { input: { id: order.id } },
          )
        ).orderMarkAsPaid,
      );
      const paid = await provider.readOrder(1, order.id);
      assert.equal(paid.fullyPaid, true);
      assert.equal(
        (await provider.reconcileCommit(1, restored, retry, retry.operationId))
          .status,
        "applied",
      );
      const ledger = await receipt("settled", {
        operationId: retry.operationId,
        snapshot: paid,
      });
      report.results = {
        originalAppliedCents: 279,
        originalFaceCents: 723,
        newRewardCents: 233,
        newRewardCode: savedReward.code,
        remainingMerchandiseCents: 88362,
        previewAgrees: true,
        lostReservationResponseRecovered: true,
        unpaidRecoveryReconciles: true,
        retryUsesSameReward: true,
        paidCommitReconciles: true,
        ledger,
      };
      return;
    }
    const plan = {
      changes: [],
      additions: [{ variantId: addedVariant, quantity: 1 }],
    };
    const preview = await provider.preview(
      await provider.preparePreview(before),
      plan,
    );
    const operationId = randomUUID();
    const quote = await provider.quote(1, before, plan, operationId);
    assert.equal(quote.financials?.itemsNetCents, 88595);
    assert.equal(quote.financials?.itemDiscounts?.[0]?.amountCents, 279);
    const display = presentOrderEditCodeBreakdown(
      quote.financials,
      quote.codePricing,
      quoteProductPrices(quote),
    )!;
    assert.equal(display.orderDiscounts?.[0]?.amountCents, 279);
    const displayedItemsSubtotal = display.lines.reduce(
      (sum, line) => sum + line.productNetCents!,
      0,
    );
    assert.equal(displayedItemsSubtotal, 88874);
    assert.equal(preview.financials.totalCents, quote.totalCents);
    assert.equal(preview.financials.taxCents, quote.financials?.taxCents);
    assert.equal(
      (await provider.readOrder(1, order.id)).fingerprint,
      before.fingerprint,
    );
    const committed = await provider.commit(1, quote, operationId);
    assert.equal(committed.subtotalCents, 88595);
    const reconciled = await provider.reconcileCommit(
      1,
      before,
      quote,
      operationId,
    );
    assert.equal(reconciled.status, "applied");
    await writeFile(
      ".codex-artifacts/preserved-reward-before-recovery.json",
      JSON.stringify({ before, quote, committed, reconciled }, null, 2),
    );
    const recoveryId = randomUUID();
    const restored = await provider.recoverUnpaid(1, before, quote, recoveryId);
    assert.equal(restored.subtotalCents, before.subtotalCents);
    assert.equal(restored.totalCents, before.totalCents);
    assert.equal(
      (await provider.reconcileRecovery(1, before, recoveryId, quote)).status,
      "restored",
    );

    // Shopify rejects increasing a line carrying a fixed native code. The
    // provider preserves that line and adds the extra quantity as a separate line.
    const quantityPlan = {
      changes: [{ lineItemId: before.lines[0].id, quantity: 2 }],
      additions: [],
    };
    const quantityId = randomUUID();
    const quantityQuote = await provider.quote(
      1,
      restored,
      quantityPlan,
      quantityId,
    );
    assert.equal(quantityQuote.financials?.itemsNetCents, 88595);
    await provider.commit(1, quantityQuote, quantityId);
    assert.equal(
      (await provider.reconcileCommit(1, restored, quantityQuote, quantityId))
        .status,
      "applied",
    );
    const secondRecovery = randomUUID();
    const restoredAgain = await provider.recoverUnpaid(
      1,
      restored,
      quantityQuote,
      secondRecovery,
    );
    assert.equal(
      (
        await provider.reconcileRecovery(
          1,
          restored,
          secondRecovery,
          quantityQuote,
        )
      ).status,
      "restored",
    );
    // A third session must ignore both historical zero-quantity rows without
    // confusing their identities with the original discounted item.
    const thirdQuote = await provider.quote(
      1,
      restoredAgain,
      plan,
      randomUUID(),
    );
    assert.equal(thirdQuote.financials?.itemsNetCents, 88595);
    assert.equal(thirdQuote.financials?.itemDiscounts?.[0]?.amountCents, 279);
    assert.equal(
      (await provider.readOrder(1, order.id)).fingerprint,
      restoredAgain.fingerprint,
    );
    report.results = {
      originalAppliedCents: 279,
      originalFaceCents: 723,
      addedMerchandiseCents: 88595,
      itemsSubtotalCents: displayedItemsSubtotal,
      displayedOrderDiscountCents: 279,
      quoteTotalCents: quote.totalCents,
      quoteTaxCents: quote.financials?.taxCents,
      previewAgrees: true,
      commitReconciles: true,
      recoveryReconciles: true,
      quantityIncreaseUsesSeparateLine: true,
      quantityRecoveryReconciles: true,
      thirdSessionReopens: true,
    };
  } finally {
    const deleted = [];
    for (const entry of cleanup.reverse()) {
      const operation =
        entry.kind === "customer"
          ? "customerDelete"
          : entry.kind === "code"
            ? "discountCodeDelete"
            : entry.kind === "draft"
              ? "draftOrderDelete"
              : "orderDelete";
      const argument =
        entry.kind === "draft" || entry.kind === "customer"
          ? "input:{id:$id}"
          : entry.kind === "order"
            ? "orderId:$id"
            : "id:$id";
      try {
        if (entry.kind === "order") {
          // Production recovery leaves restocking to the warehouse owner. These
          // synthetic orders have no warehouse, so restore only the units removed
          // by this fixture, in addition to orderCancel's remaining-unit restock.
          const beforeCancel = (
            await request<{
              order: {
                lineItems: {
                  pageInfo: { hasNextPage: boolean };
                  nodes: Array<{
                    quantity: number;
                    currentQuantity: number;
                    variant: { id: string };
                  }>;
                };
              };
            }>(
              `query($id:ID!){order(id:$id){lineItems(first:250){
              pageInfo{hasNextPage}nodes{quantity currentQuantity variant{id}}}}}`,
              { id: entry.id },
            )
          ).order.lineItems;
          assert.equal(beforeCancel.pageInfo.hasNextPage, false);
          assert.ok(
            beforeCancel.nodes.every(
              (line) =>
                line.variant.id === originalVariant &&
                line.quantity >= line.currentQuantity,
            ),
          );
          const removedUnits = beforeCancel.nodes.reduce(
            (total, line) => total + line.quantity - line.currentQuantity,
            0,
          );
          const cancelled = (
            await request<{
              orderCancel: {
                job: { id: string; done: boolean };
                orderCancelUserErrors: unknown[];
              };
            }>(
              `mutation($id:ID!){orderCancel(orderId:$id,notifyCustomer:false,
          refundMethod:{originalPaymentMethodsRefund:false},restock:true,reason:OTHER){
          job{id done}orderCancelUserErrors{message}}}`,
              { id: entry.id },
            )
          ).orderCancel;
          assert.deepEqual(cancelled.orderCancelUserErrors, []);
          let done = cancelled.job.done;
          for (let attempt = 0; !done && attempt < 20; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            done = (
              await request<{ job: { done: boolean } }>(
                `query($id:ID!){job(id:$id){done}}`,
                { id: cancelled.job.id },
              )
            ).job.done;
          }
          assert.equal(
            done,
            true,
            "Test-order cancellation did not finish; retain its ID for cleanup.",
          );
          if (removedUnits > 0) {
            assert.ok(testInventory);
            const inventory = (
              await request<{
                inventoryItem: {
                  inventoryLevel: {
                    quantities: Array<{ name: string; quantity: number }>;
                  };
                };
              }>(
                `query($id:ID!,$location:ID!){inventoryItem(id:$id){
                inventoryLevel(locationId:$location){quantities(names:["available"]){name quantity}}}}`,
                {
                  id: testInventory.inventoryItemId,
                  location: testInventory.locationId,
                },
              )
            ).inventoryItem.inventoryLevel.quantities;
            assert.equal(inventory.length, 1);
            assert.equal(inventory[0].name, "available");
            result(
              (
                await request<{
                  inventoryAdjustQuantities: Result<unknown>;
                }>(
                  `mutation($input:InventoryAdjustQuantitiesInput!,$key:String!){
                  inventoryAdjustQuantities(input:$input) @idempotent(key:$key){
                    userErrors{message}}}`,
                  {
                    input: {
                      reason: "correction",
                      name: "available",
                      referenceDocumentUri: `test-fixture://${fixture}/recovery`,
                      changes: [
                        {
                          ...testInventory,
                          delta: removedUnits,
                          changeFromQuantity: inventory[0].quantity,
                        },
                      ],
                    },
                    key: inventoryRecoveryKey,
                  },
                )
              ).inventoryAdjustQuantities,
            );
          }
          report.inventoryRestoredUnits = removedUnits;
        }
        result(
          (
            await request<Record<string, Result<unknown>>>(
              `mutation($id:ID!){${operation}(${argument}){userErrors{message}}}`,
              { id: entry.id },
            )
          )[operation],
        );
        deleted.push({ ...entry, deleted: true });
      } catch (error) {
        deleted.push({
          ...entry,
          deleted: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    report.cleanup = deleted;
    if (testInventory) {
      report.inventoryAfter = (
        await request<{ productVariant: { inventoryQuantity: number } }>(
          `query($id:ID!){productVariant(id:$id){inventoryQuantity}}`,
          { id: originalVariant },
        )
      ).productVariant.inventoryQuantity;
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(
      ".codex-artifacts/preserved-reward-staging.json",
      JSON.stringify(report, null, 2),
    );
    assert.ok(
      deleted.every((entry) => entry.deleted),
      "Inspect the report for a test fixture that needs cleanup.",
    );
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
