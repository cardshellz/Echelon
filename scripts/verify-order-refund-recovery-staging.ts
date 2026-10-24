/** Native refund acceptance on newly created TEST resources in the named
 * development shop. No live account, existing order or points ledger is used. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import Decimal from "decimal.js";
import { ShopifyOrderEditProvider } from "../server/modules/order-edits/infrastructure/shopify-order-edit.provider";
import { OrderEditService } from "../server/modules/order-edits/application/order-edit.service";
import { OrderEditError } from "../server/modules/order-edits/domain/order-edit-error";
import { readShopifyMerchandiseSnapshot } from "../server/modules/oms/infrastructure/shopify-merchandise-snapshot";
import { proveStoppedRefundEditRecovery } from "../server/modules/order-edits/infrastructure/order-edit-refund-warehouse-evidence";
import { OrderCancellationService } from "../server/modules/customer-account/application/order-cancellation.service";
import type {
  OrderEditRecord,
  OrderEditStore,
  OrderEditWarehouse,
} from "../server/modules/order-edits/application/order-edit-store";
import type { OrderEditSnapshot } from "../server/modules/order-edits/application/order-edit-provider";

const shop = z
  .literal("cardshellz-staging.myshopify.com")
  .parse(process.env.REWARDS_STAGING_SHOP);
const token = z.string().min(1).parse(process.env.REWARDS_STAGING_TOKEN);
const fixture = `refund-${randomUUID().replaceAll("-", "")}`;
const operationId = randomUUID();
const refundKey = randomUUID();
const report: Record<string, unknown> = {
  fixture,
  shop,
  operationId,
  realOrdersChanged: 0,
  realPointsChanged: 0,
  refundCreateCommands: 0,
  intentionallyIncompleteResponses: 0,
  warehouseReleases: 0,
};
let customerId: string | null = null,
  orderId: string | null = null;
let baseline: OrderEditSnapshot | null = null,
  saved: OrderEditRecord | null = null,
  locked = false;
const events: string[] = [];
const records = new Map<string, OrderEditRecord>();
let warehouseStopped = false, synchronizationInterrupted = false;
const userErrors = z.array(z.object({ message: z.string() }));
async function saveReport(): Promise<void> {
  await mkdir(".codex-artifacts", { recursive: true });
  await writeFile(
    ".codex-artifacts/order-refund-recovery-staging.json",
    JSON.stringify({ ...report, events, saved }, null, 2),
  );
}
async function request<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(
    `https://${shop}/admin/api/2026-10/graphql.json`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const value = z
    .object({
      data: z.unknown().optional(),
      errors: z.array(z.object({ message: z.string() })).optional(),
    })
    .parse(await response.json());
  assert.equal(response.ok, true, `Shopify HTTP ${response.status}`);
  assert.equal(value.errors, undefined, JSON.stringify(value.errors));
  // The shared GraphQL transport is generic; each acceptance read validates
  // its actual response with the corresponding Zod boundary before use.
  return value.data as T;
}
const identity = z.object({ id: z.string().min(1) });
const provider = new ShopifyOrderEditProvider({
  clock: () => new Date(),
  credentials: {
    get: async () => ({
      connectionId: 4,
      channelId: 36,
      shopDomain: shop,
      accessToken: token,
    }),
  },
  // Free delivery is an explicit synthetic policy; native amounts and refund
  // transactions remain Shopify evidence. Warehouse ownership is tested in PG.
  shippingCalculator: {
    calculate: async () => ({
      title: "Synthetic free delivery",
      code: "synthetic-free",
      source: "Echelon Shipping",
      grossCents: 0,
      netCents: 0,
      discountCents: 0,
      discountLabels: [],
    }),
  },
  fetch: async (input, init) => {
    assert.equal(new URL(String(input)).hostname, shop);
    const body = z
      .object({ query: z.string() })
      .parse(JSON.parse(String(init?.body)));
    if (body.query.includes("orderCancel("))
      report.cancellationCommands = Number(report.cancellationCommands ?? 0) + 1;
    if (body.query.includes("refundCreate"))
      report.merchandiseBeforeRefund = await readShopifyMerchandiseSnapshot({ request }, { shopDomain: shop, orderId: orderId! });
    const response = await fetch(input, init);
    if (!body.query.includes("refundCreate")) {
      const projection = await response.clone().json();
      if (projection.errors) {
        report.providerGraphqlErrors = projection.errors;
        await saveReport();
      }
      if (
        body.query.includes("query EchelonEditOrder(") &&
        projection.data?.order
      ) {
        report.nativeLineEvidence = projection.data.order.lineItems.nodes.map(
          (line: {
            id: string;
            merchantEditable: boolean;
            requiresShipping: boolean;
            isGiftCard: boolean;
            variant: unknown;
            sellingPlan: unknown;
            lineItemGroup: unknown;
          }) => ({
            id: line.id,
            merchantEditable: line.merchantEditable,
            requiresShipping: line.requiresShipping,
            isGiftCard: line.isGiftCard,
            variant: line.variant,
            sellingPlan: line.sellingPlan,
            lineItemGroup: line.lineItemGroup,
          }),
        );
        report.nativeCountry =
          projection.data.order.shippingAddress?.countryCodeV2;
        await saveReport();
      }
      return response;
    }
    report.refundCreateCommands = Number(report.refundCreateCommands) + 1;
    await saveReport();
    const value = await response.json();
    if (
      response.ok &&
      value.data?.refundCreate?.refund &&
      report.intentionallyIncompleteResponses === 0
    ) {
      // Reproduce the original partial projection after ONE real native command.
      const refund = value.data.refundCreate.refund;
      refund.note = null;
      refund.transactions.nodes = [];
      for (const money of Object.values(refund.totalRefundedSet) as Array<{
        amount: string;
      }>)
        money.amount = "0.00";
      report.intentionallyIncompleteResponses = 1;
      await saveReport();
    }
    return new Response(JSON.stringify(value), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  },
});
const reference = () => {
  assert.ok(baseline && orderId);
  return {
    omsOrderId: 1,
    connectionId: 4,
    channelId: 36,
    externalOrderId: orderId,
    externalCustomerId:
      baseline.customerId?.replace(/^gid:\/\/shopify\/Customer\//, "") ?? null,
    orderNumber: baseline.name,
    customerName: "Synthetic",
    customerEmail: null,
    activeOperationId:
      saved &&
      !["completed", "recovered", "failed", "expired"].includes(saved.status)
        ? saved.id
        : null,
  };
};
const store: OrderEditStore = {
  connections: async () => [await store.settings(4)],
  settings: async () => ({
    connectionId: 4,
    channelId: 36,
    shopDomain: shop,
    name: "Synthetic development shop",
    enabled: true,
    paymentWindowMinutes: 30,
  }),
  saveSettings: async () => {
    throw new Error("The acceptance test cannot change settings.");
  },
  findOrders: async () => [reference()],
  orderReference: async () => reference(),
  withOrderLock: async (_id, work) => {
    if (locked)
      throw new OrderEditError("ORDER_EDIT_BUSY", "Synthetic lock is busy.");
    locked = true;
    try {
      return await work();
    } finally {
      locked = false;
    }
  },
  findByRequestKey: async (key) =>
    structuredClone([...records.values()].find(record => record.requestKey === key) ?? null),
  get: async (id) => {
    assert.ok(records.has(id));
    return structuredClone(records.get(id)!);
  },
  create: async (record) => {
    assert.ok(!saved || ["completed", "recovered", "failed", "expired"].includes(saved.status));
    saved = structuredClone(record);
    records.set(record.id, saved);
    await saveReport();
  },
  save: async (record, version, _actor, action, proof) => {
    assert.equal(records.get(record.id)?.version, version);
    if (["completed", "recovered", "expired"].includes(record.status))
      assert.ok(proof);
    saved = structuredClone(record);
    records.set(record.id, saved);
    events.push(action);
    await saveReport();
  },
  pending: async () => [...records.values()].filter(record => !["completed", "recovered", "failed", "expired"].includes(record.status)).map(record => record.id),
};
const warehouse: OrderEditWarehouse = {
  inspect: async () => ({ editable: true, reasons: [], wmsOrderIds: [1] }),
  acquire: async () => {},
  assertHeld: async (_id, operation, snapshot) => {
    if (!warehouseStopped) return;
    if (!snapshot) throw new OrderEditError("ORDER_EDIT_PICKING_CUTOFF", "Synthetic stopped warehouse work");
    proveStoppedRefundEditRecovery({ operationId: operation, omsOrderId: 1, document: await store.get(operation), snapshot });
    warehouseStopped = false;
    report.stoppedWarehouseProofVerified = true;
  },
  releaseUnsubmitted: async () => ({
    ownership: "none",
    unsubmitted: true,
    wmsOrderIds: [],
    shipmentIds: [],
    contentFingerprint: "synthetic",
  }),
  releaseUnchanged: async () => ({
    wmsOrderIds: [1],
    shipmentIds: [],
    contentFingerprint: "synthetic",
  }),
  releaseFulfilledUnsubmitted: async () => {
    throw new Error("Fulfilled cleanup is outside this synthetic test.");
  },
  reconcileAndRelease: async (_id, _operation, snapshot) => {
    assert.equal(snapshot.netPaidCents, snapshot.totalCents);
    assert.equal(snapshot.outstandingCents, 0);
    if (!synchronizationInterrupted) {
      synchronizationInterrupted = true;
      throw new Error("Synthetic interrupted synchronization after verified refund");
    }
    report.warehouseReleases = Number(report.warehouseReleases) + 1;
    return {
      wmsOrderIds: [1],
      shipmentIds: [],
      contentFingerprint: "synthetic",
      allocationRequired: true,
    };
  },
  cancellationReleaseProof: async () => {
    const snapshot = await provider.readOrder(4, orderId!);
    assert.equal(snapshot.cancelled, true);
    assert.equal(snapshot.netPaidCents, 0);
    return { cancelledOrder: true, wmsOrderIds: [1], shipmentIds: [], contentFingerprint: "synthetic-cancelled" };
  },
};
let uuidIndex = 0;
const service = new OrderEditService(
  store,
  provider,
  warehouse,
  () => new Date(),
  () => (uuidIndex++ === 0 ? operationId : refundKey),
  (event) => {
    report.lastDiagnostic = event.code;
  },
  undefined, undefined, undefined, undefined, () => true,
);

try {
  z.object({
    shop: z.object({
      myshopifyDomain: z.literal(shop),
      plan: z.object({ partnerDevelopment: z.literal(true) }),
    }),
  }).parse(
    await request(
      "query { shop { myshopifyDomain plan { partnerDevelopment } } }",
    ),
  );
  await saveReport();
  // Reuse the established development-store catalog fixture without changing
  // its definition or inventory. Order creation explicitly bypasses inventory.
  const variantId = "gid://shopify/ProductVariant/45456261873862";
  const variant = z
    .object({
      productVariant: z.object({
        id: z.literal(variantId),
        price: z.string().regex(/^\d+\.\d{2}$/),
      }),
    })
    .parse(
      await request("query($id:ID!){productVariant(id:$id){id price}}", {
        id: variantId,
      }),
    ).productVariant;
  const unitCents = z
    .number()
    .int()
    .positive()
    .safe()
    .parse(new Decimal(variant.price).mul(100).toNumber());
  const paymentAmount = new Decimal(variant.price).mul(2).toFixed(2);
  const customer = z
    .object({ customerCreate: z.object({ customer: identity, userErrors }) })
    .parse(
      await request(
        "mutation($input:CustomerInput!){customerCreate(input:$input){customer{id}userErrors{message}}}",
        {
          input: {
            firstName: "Synthetic",
            lastName: fixture,
            tags: [fixture],
            taxExempt: true,
          },
        },
      ),
    ).customerCreate;
  assert.deepEqual(customer.userErrors, []);
  customerId = customer.customer.id;
  report.customerId = customerId;
  await saveReport();
  const created = z
    .object({
      orderCreate: z.object({
        userErrors,
        order: z
          .object({
            id: z.string(),
            test: z.literal(true),
            note: z.literal(fixture),
          })
          .nullable(),
      }),
    })
    .parse(
      await request(
        "mutation($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput){orderCreate(order:$order,options:$options){order{id test note}userErrors{message}}}",
        {
          order: {
            test: true,
            currency: "USD",
            customerId,
            note: fixture,
            tags: [fixture],
            taxesIncluded: false,
            taxLines: [],
            shippingAddress: {
              firstName: "Synthetic",
              lastName: "Acceptance",
              address1: "1 Main Street",
              city: "Pittsburgh",
              provinceCode: "PA",
              countryCode: "US",
              zip: "15222",
            },
            lineItems: [{ variantId, quantity: 2, requiresShipping: true }],
            transactions: [
              {
                kind: "SALE",
                status: "SUCCESS",
                gateway: "bogus",
                authorizationCode: "synthetic-acceptance",
                test: true,
                amountSet: {
                  shopMoney: { amount: paymentAmount, currencyCode: "USD" },
                },
              },
            ],
          },
          options: {
            sendReceipt: false,
            sendFulfillmentReceipt: false,
            inventoryBehaviour: "BYPASS",
          },
        },
      ),
    ).orderCreate;
  if (created.order) {
    orderId = created.order.id;
    report.orderId = orderId;
  }
  report.orderCreateErrors = created.userErrors;
  await saveReport();
  assert.deepEqual(created.userErrors, []);
  assert.ok(created.order);
  const nativeOrderId = created.order.id;
  baseline = await provider.readOrder(4, nativeOrderId);
  report.nativeBaseline = {
    customerId: baseline.customerId,
    netPaidCents: baseline.netPaidCents,
    totalCents: baseline.totalCents,
    fullyPaid: baseline.fullyPaid,
  };
  await saveReport();
  assert.equal(baseline.customerId, customerId);
  assert.equal(baseline.netPaidCents, unitCents * 2);
  assert.equal(baseline.fullyPaid, true);
  report.baselinePayment = baseline.transactions.map((transaction) => ({
    gateway: transaction.gateway,
    manual: transaction.manual,
    status: transaction.status,
  }));
  const quote = await service.quote(
    {
      connectionId: 4,
      omsOrderId: 1,
      expectedRevision: baseline.fingerprint,
      requestKey: randomUUID(),
      changes: [{ lineItemId: baseline.lines[0].id, quantity: 1 }],
      additions: [],
    },
    "synthetic-acceptance",
  );
  assert.equal(quote.status, "ready");
  const committed = await service.commit(
    operationId,
    randomUUID(),
    "synthetic-acceptance",
  );
  assert.equal(committed.status, "refunding");
  assert.equal(committed.error?.code, "REFUND_READBACK_PENDING");
  assert.equal(report.refundCreateCommands, 1);
  assert.equal(report.warehouseReleases, 0);
  // Exercise the historical review state against the same real native refund.
  const existingRecord = await store.get(operationId);
  const legacy: OrderEditRecord = {
    ...existingRecord,
    status: "review_required",
    version: existingRecord.version + 1,
    error: {
      code: "ORDER_EDIT_PICKING_CUTOFF",
      message: "Synthetic historical creation-readback mismatch",
    },
  };
  await store.save(
    legacy,
    existingRecord.version,
    "synthetic-acceptance",
    "simulate_legacy_review",
  );
  warehouseStopped = true;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await service.sweep();
    if ((await store.get(operationId)).status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const completed = await store.get(operationId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.error, null);
  assert.equal(report.refundCreateCommands, 1);
  assert.equal(report.warehouseReleases, 1);
  assert.equal(report.stoppedWarehouseProofVerified, true);
  assert.equal(synchronizationInterrupted, true);
  const settled = await provider.readOrder(4, nativeOrderId);
  assert.equal(settled.totalCents, unitCents);
  assert.equal(settled.netPaidCents, unitCents);
  assert.equal(settled.outstandingCents, 0);
  const refund = await provider.observeRefund(4, completed.refundIntent!);
  assert.equal(refund?.status, "succeeded");
  assert.equal(refund.evidence.amountCents, unitCents);
  report.confirmedRefundId = refund.refundId;
  report.settledTotalCents = settled.totalCents;
  await service.sweep();
  await service.reconcile(operationId, "synthetic-acceptance");
  assert.equal(report.refundCreateCommands, 1);
  assert.equal(report.warehouseReleases, 1);
  const merchandise = await readShopifyMerchandiseSnapshot({ request }, { shopDomain: shop, orderId: nativeOrderId });
  const beforeRefund = report.merchandiseBeforeRefund as typeof merchandise;
  assert.deepEqual(merchandise.lines.map(line => [line.id, line.currentQuantity]), beforeRefund.lines.map(line => [line.id, line.currentQuantity]));
  assert.equal(merchandise.cancelled, false);
  assert.equal(merchandise.lines.reduce((sum, line) => sum + line.currentQuantity, 0), 1);
  report.nativeMerchandiseAfterRefund = merchandise;
  report.refundOperationCompleted = completed.id;
  let expectedCancellationRefund = unitCents;
  if (process.env.TEST_FULL_MONEY_REFUND === "true") {
    // Separate administrative money-only refund on this freshly-created TEST
    // order. No line quantities, catalog inventory or Club balance are changed.
    const payment = baseline.transactions.filter(tx => ["SALE", "CAPTURE"].includes(tx.kind) && tx.status === "SUCCESS");
    assert.equal(payment.length, 1);
    const moneyVariables = { key: randomUUID(), input: { orderId: nativeOrderId, currency: "USD", notify: false,
      note: `Synthetic money-only ${fixture}`, transactions: [{ orderId: nativeOrderId, parentId: payment[0].id,
        gateway: payment[0].gateway, kind: "REFUND", amount: new Decimal(unitCents).div(100).toFixed(2) }] } };
    const mutation = `mutation SyntheticMerchandiseMoneyRefund($input:RefundInput!,$key:String!){
      refundCreate(input:$input) @idempotent(key:$key){refund{id}userErrors{message}}}`;
    const moneyResponse = z.object({ refundCreate: z.object({ refund: identity, userErrors }) });
    const money = moneyResponse.parse(await request(mutation, moneyVariables)).refundCreate;
    assert.deepEqual(money.userErrors, []);
    const retried = moneyResponse.parse(await request(mutation, moneyVariables)).refundCreate;
    assert.deepEqual(retried.userErrors, []);
    assert.equal(retried.refund.id, money.refund.id);
    let refunded = await provider.readOrder(4, nativeOrderId);
    for (let attempt = 0; refunded.netPaidCents !== 0 && attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      refunded = await provider.readOrder(4, nativeOrderId);
    }
    assert.equal(refunded.netPaidCents, 0);
    const afterMoney = await readShopifyMerchandiseSnapshot({ request }, { shopDomain: shop, orderId: nativeOrderId });
    assert.deepEqual(afterMoney.lines.map(line => [line.id, line.currentQuantity]), merchandise.lines.map(line => [line.id, line.currentQuantity]));
    const requests = z.object({ order: z.object({ fulfillmentOrders: z.object({ nodes: z.array(z.object({
      id: z.string(), status: z.string(), lineItems: z.object({ nodes: z.array(z.object({ remainingQuantity: z.number().int().nonnegative() })) }),
    })) }) }) }).parse(await request(`query($id:ID!){order(id:$id){fulfillmentOrders(first:10){nodes{
      id status lineItems(first:10){nodes{remainingQuantity}}}}}}`, { id: nativeOrderId }));
    assert.equal(requests.order.fulfillmentOrders.nodes.flatMap(order => order.lineItems.nodes).reduce((sum, line) => sum + line.remainingQuantity, 0), 1);
    report.fullMoneyRefund = { refundId: money.refund.id, retryReturnedSameRefund: true,
      netPaidCents: refunded.netPaidCents, outstandingCents: refunded.outstandingCents, fullyPaid: refunded.fullyPaid,
      merchandise: afterMoney, fulfillmentOrders: requests.order.fulfillmentOrders.nodes };
    expectedCancellationRefund = 0;
    await saveReport();
  }
  // Explicit cancellation is a separate command after recovery, over only the
  // remaining settled payment. Rewards here are a zero-points synthetic port.
  const noRewards = { fingerprint: "0".repeat(64), returnedPoints: "0.00", deductedEarnedPoints: "0.00", settled: false };
  const cancellation = new OrderCancellationService({ store, provider, warehouse,
    allowSettledRefundBalance: () => true,
    rewards: { reviewCancellation: async () => noRewards, settleCancellation: async () => ({ ...noRewards, settled: true }) },
    clock: () => new Date(), uuid: randomUUID, report: event => { report.cancellationDiagnostic = event.code; } });
  const review = await cancellation.review(4, 1);
  assert.equal(review.eligibility.allowed, true, JSON.stringify(review.eligibility.reasons));
  assert.equal(review.refundCents, expectedCancellationRefund);
  const cancellationInput = { connectionId: 4, omsOrderId: 1, requestKey: randomUUID(), expectedRevision: review.revision };
  let cancelled = await cancellation.submit(cancellationInput, "synthetic-acceptance");
  for (let attempt = 0; cancelled.status !== "completed" && attempt < 30; attempt++) {
    await cancellation.reconcile(cancelled.operationId);
    cancelled = await cancellation.staffGet(cancelled.operationId);
    if (cancelled.status !== "completed") await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(cancelled.status, "completed");
  await cancellation.submit(cancellationInput, "synthetic-acceptance");
  await cancellation.reconcile(cancelled.operationId);
  assert.equal(report.cancellationCommands, 1);
  assert.equal(report.refundCreateCommands, 1);
  assert.equal((await store.pending(25, new Date())).length, 0);
  report.cancellationCompletedAfterRefundRecovery = true;
  report.accepted = true;
} catch (error) {
  report.failure =
    error instanceof Error
      ? {
          message: error.message,
          code: "code" in error ? error.code : undefined,
        }
      : { message: "Unknown acceptance failure" };
  await saveReport();
  throw error;
} finally {
  // Only resources whose identity and unique marker were verified above can be removed.
  const cleanup: string[] = [];
  if (orderId) {
    z.object({
      order: z.object({
        id: z.literal(orderId),
        test: z.literal(true),
        note: z.literal(fixture),
      }),
    }).parse(
      await request("query($id:ID!){order(id:$id){id test note}}", {
        id: orderId,
      }),
    );
    // Shopify permits deletion of TEST orders. The unique marker and TEST flag
    // above authorize only this fixture; cleanup needs no second refund command.
    const deleted = z
      .object({
        orderDelete: z.object({ deletedId: z.literal(orderId), userErrors }),
      })
      .parse(
        await request(
          "mutation($id:ID!){orderDelete(orderId:$id){deletedId userErrors{message}}}",
          { id: orderId },
        ),
      );
    assert.deepEqual(deleted.orderDelete.userErrors, []);
    cleanup.push("order");
  }
  if (customerId) {
    z.object({
      customer: z.object({
        id: z.literal(customerId),
        tags: z.array(z.string()).refine((tags) => tags.includes(fixture)),
      }),
    }).parse(
      await request("query($id:ID!){customer(id:$id){id tags}}", {
        id: customerId,
      }),
    );
    const deleted = z
      .object({ customerDelete: z.object({ userErrors }) })
      .parse(
        await request(
          "mutation($id:ID!){customerDelete(input:{id:$id}){userErrors{message}}}",
          { id: customerId },
        ),
      );
    assert.deepEqual(deleted.customerDelete.userErrors, []);
    cleanup.push("customer");
  }
  report.cleanup = cleanup;
  report.finishedAt = new Date().toISOString();
  await saveReport();
}
console.log(
  JSON.stringify({
    accepted: report.accepted,
    refundCreateCommands: report.refundCreateCommands,
    warehouseReleases: report.warehouseReleases,
    realOrdersChanged: 0,
    realPointsChanged: 0,
    cleanup: report.cleanup,
  }),
);
