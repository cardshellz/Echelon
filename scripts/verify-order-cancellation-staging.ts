/** Native acceptance uses only disposable resources in the named development
 * store. No production connection, customer order or Club balance is accepted. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { ShopifyOrderEditProvider } from "../server/modules/order-edits/infrastructure/shopify-order-edit.provider";
import { cancellationPaymentsSettled } from "../server/modules/customer-account/application/order-cancellation.ports";
import { matchesOrderCancellationSettlement } from "../server/modules/order-edits/domain/order-edit-financials";

const shop = z
  .literal("cardshellz-staging.myshopify.com")
  .parse(process.env.REWARDS_STAGING_SHOP);
const token = z.string().min(1).parse(process.env.REWARDS_STAGING_TOKEN);
const fixture = `cancel-${randomUUID().replaceAll("-", "")}`,
  operationId = randomUUID();
const report: Record<string, unknown> = {
  fixture,
  shop,
  operationId,
  realOrdersChanged: 0,
  realPointsChanged: 0,
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  cancellationSubmissions: 0,
};
let customerId: string | null = null,
  draftId: string | null = null,
  orderId: string | null = null,
  cancellationSent = false;
async function saveReport(): Promise<void> {
  await mkdir(".codex-artifacts", { recursive: true });
  await writeFile(
    ".codex-artifacts/order-cancellation-staging.json",
    JSON.stringify(report, null, 2),
  );
}
async function request(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await fetch(
    `https://${shop}/admin/api/2026-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
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
  return value.data;
}
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
});
const userErrors = z.array(z.object({ message: z.string() }));
const identity = z.object({ id: z.string().min(1) });
async function observeCancellation(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    assert.ok(orderId);
    const job = await provider.cancellationJob(4, jobId);
    assert.equal(job.failed, false, "Native cancellation job failed");
    const snapshot = await provider.readOrder(4, orderId);
    if (
      job.done &&
      job.orderId === orderId &&
      cancellationPaymentsSettled(snapshot)
    ) {
      report.cancelled = snapshot.cancelled;
      report.netPaidCents = snapshot.netPaidCents;
      report.outstandingCents = snapshot.outstandingCents;
      report.refunds = snapshot.refunds;
      report.jobDone = true;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    "Native cancellation has not settled; retain the fixture identity for status-only recovery.",
  );
}
try {
  const development = z
    .object({
      shop: z.object({
        myshopifyDomain: z.literal(shop),
        plan: z.object({ partnerDevelopment: z.literal(true) }),
      }),
    })
    .parse(
      await request(
        "query { shop { myshopifyDomain plan { partnerDevelopment } } }",
      ),
    );
  report.developmentStore = development.shop.plan.partnerDevelopment;
  await saveReport(); // Persist the unique marker before any external mutation.
  const customer = z
    .object({ customerCreate: z.object({ customer: identity, userErrors }) })
    .parse(
      await request(
        "mutation($input:CustomerInput!){customerCreate(input:$input){customer{id}userErrors{message}}}",
        {
          input: { firstName: "Synthetic", lastName: fixture, tags: [fixture] },
        },
      ),
    ).customerCreate;
  assert.deepEqual(customer.userErrors, []);
  customerId = customer.customer.id;
  report.customerId = customerId;
  await saveReport();
  const draft = z
    .object({
      draftOrderCreate: z.object({
        draftOrder: identity.nullable(),
        userErrors,
      }),
    })
    .parse(
      await request(
        "mutation($input:DraftOrderInput!){draftOrderCreate(input:$input){draftOrder{id}userErrors{message}}}",
        {
          input: {
            customerId,
            note: fixture,
            tags: [fixture],
            visibleToCustomer: false,
            taxExempt: true,
            acceptAutomaticDiscounts: false,
            shippingAddress: {
              firstName: "Synthetic",
              lastName: "Acceptance",
              address1: "1 Main Street",
              city: "Pittsburgh",
              provinceCode: "PA",
              countryCode: "US",
              zip: "15222",
            },
            lineItems: [
              {
                variantId: "gid://shopify/ProductVariant/45456261873862",
                quantity: 1,
                priceOverride: { amount: "2.33", currencyCode: "USD" },
              },
            ],
          },
        },
      ),
    ).draftOrderCreate;
  assert.deepEqual(draft.userErrors, []);
  assert.ok(draft.draftOrder);
  draftId = draft.draftOrder.id;
  report.draftId = draftId;
  await saveReport();
  const completed = z
    .object({
      draftOrderComplete: z.object({
        draftOrder: z.object({ order: identity }),
        userErrors,
      }),
    })
    .parse(
      await request(
        "mutation($id:ID!){draftOrderComplete(id:$id,paymentPending:false){draftOrder{order{id}}userErrors{message}}}",
        { id: draftId },
      ),
    ).draftOrderComplete;
  assert.deepEqual(completed.userErrors, []);
  orderId = completed.draftOrder.order.id;
  report.orderId = orderId;
  await saveReport();
  const baseline = await provider.readOrder(4, orderId);
  assert.equal(baseline.customerId, customerId);
  assert.equal(baseline.fullyPaid, true);
  assert.equal(baseline.netPaidCents, 233);
  report.before = {
    netPaidCents: baseline.netPaidCents,
    totalCents: baseline.totalCents,
  };
  cancellationSent = true;
  report.cancellationSubmissions = 1;
  await saveReport();
  const cancellation = await provider.cancelOrder(4, orderId, operationId);
  report.jobId = cancellation.jobId;
  await saveReport();
  await observeCancellation(cancellation.jobId);
  // The service's retry tests prove single submission; native acceptance checks
  // the actual asynchronous result, complete refund and safe read-only replay.
  const again = await provider.cancellationJob(4, cancellation.jobId);
  assert.equal(again.done, true);
  assert.equal(again.failed, false);
  assert.equal(matchesOrderCancellationSettlement(baseline, await provider.readOrder(4, orderId), 233), true);
  report.accepted = true;
} finally {
  const cleanup: Array<{ kind: string; id: string; deleted: boolean }> = [];
  let cleanupFailure: unknown;
  try {
    if (orderId) {
      const scoped = z
        .object({
          order: z.object({
            id: z.literal(orderId),
            note: z.literal(fixture),
            cancelledAt: z.string().nullable(),
          }),
        })
        .parse(
          await request("query($id:ID!){order(id:$id){id note cancelledAt}}", {
            id: orderId,
          }),
        ).order;
      if (!scoped.cancelledAt && !cancellationSent) {
        cancellationSent = true;
        report.cancellationSubmissions = 1;
        const cancellation = await provider.cancelOrder(
          4,
          orderId,
          operationId,
        );
        report.jobId = cancellation.jobId;
        await observeCancellation(cancellation.jobId);
      }
      const snapshot = await provider.readOrder(4, orderId);
      if (cancellationPaymentsSettled(snapshot)) {
        const result = z
          .object({
            orderDelete: z.object({
              deletedId: z.string().nullable(),
              userErrors,
            }),
          })
          .parse(
            await request(
              "mutation($id:ID!){orderDelete(orderId:$id){deletedId userErrors{message}}}",
              { id: orderId },
            ),
          ).orderDelete;
        assert.deepEqual(result.userErrors, []);
        assert.equal(result.deletedId, orderId);
        cleanup.push({ kind: "order", id: orderId, deleted: true });
      } else cleanup.push({ kind: "order", id: orderId, deleted: false });
    }
    if (draftId) {
      const draft = z
        .object({
          draftOrder: z
            .object({
              id: z.literal(draftId),
              tags: z
                .array(z.string())
                .refine((tags) => tags.includes(fixture)),
            })
            .nullable(),
        })
        .parse(
          await request("query($id:ID!){draftOrder(id:$id){id tags}}", {
            id: draftId,
          }),
        ).draftOrder;
      if (draft) {
        const data = z
          .object({ draftOrderDelete: z.object({ userErrors }) })
          .parse(
            await request(
              "mutation($id:ID!){draftOrderDelete(input:{id:$id}){userErrors{message}}}",
              { id: draftId },
            ),
          );
        assert.deepEqual(data.draftOrderDelete.userErrors, []);
      }
      cleanup.push({ kind: "draft", id: draftId, deleted: true });
    }
    if (customerId && cleanup.every((item) => item.deleted)) {
      const data = z
        .object({ customerDelete: z.object({ userErrors }) })
        .parse(
          await request(
            "mutation($id:ID!){customerDelete(input:{id:$id}){userErrors{message}}}",
            { id: customerId },
          ),
        );
      assert.deepEqual(data.customerDelete.userErrors, []);
      cleanup.push({ kind: "customer", id: customerId, deleted: true });
    }
  } catch (error) {
    cleanupFailure = error;
    report.cleanupFailed = true;
  }
  report.cleanup = cleanup;
  report.finishedAt = new Date().toISOString();
  await saveReport();
  if (cleanupFailure) throw cleanupFailure;
  assert.ok(
    cleanup.every((item) => item.deleted),
    "Synthetic cancellation needs status-only recovery; see the saved report.",
  );
}
console.log(
  JSON.stringify({
    accepted: report.accepted,
    shop,
    cancellationSubmissions: report.cancellationSubmissions,
    realOrdersChanged: 0,
    realPointsChanged: 0,
    cleanup: report.cleanup,
  }),
);
