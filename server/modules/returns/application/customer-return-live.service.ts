import { createHash } from "node:crypto";
import { z } from "zod";
import {
  customerReturnLiveLookupInputSchema, customerReturnLiveOrderSchema, customerReturnLiveReviewInputSchema,
  customerReturnLiveReviewSchema, customerReturnLiveStateSchema,
  type CustomerReturnLiveLookupInput, type CustomerReturnLiveOrder, type CustomerReturnLiveReview, type CustomerReturnLiveState,
} from "../../../../shared/returns/customer-return-live.contract";
import { DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS, evaluateCustomerReturnEligibility,
  type CustomerReturnEligibilityOutput, type CustomerReturnEligibilityInput } from "../domain/customer-return-eligibility";
import { CustomerReturnOrderReferenceError, normalizeCustomerReturnOrderReference } from "../domain/customer-return-order-reference";
import { CustomerReturnBoxPlanError, validateCustomerReturnBoxPlan } from "./customer-return-box-plan";
import { CustomerReturnLiveError } from "./customer-return-live-error";
import { readCustomerReturnLiveClaims } from "./customer-return-live-claims";
import { projectCustomerReturnLiveDelivery } from "./customer-return-live-delivery";
import { customerReturnProviderGid as gid } from "./customer-return-live-identity";
import { customerReturnPublicLineId, readCustomerReturnOriginalBoxes, type ReturnBoxReporter } from "./customer-return-live-packaging";
import type { CustomerReturnPackageDimensionsReader } from "./customer-return-package-dimensions.ports";
import { CustomerReturnLocalInspectionError, customerReturnInspectionShopSchema, customerReturnLocalInspectionSnapshotSchema,
  type CustomerReturnLocalInspectionReader, type CustomerReturnLocalInspectionSnapshot } from "./customer-return-local-inspection.ports";
import { CustomerReturnShopifySnapshotError, customerReturnShopifySnapshotSchema,
  type CustomerReturnShopifySnapshotReader, type CustomerReturnShopifySnapshot } from "./customer-return-shopify-snapshot.ports";

const MAX_OBSERVATION_AGE_MS = 120_000;
const POLICY_VERSION = 1;
export interface CustomerReturnLiveDependencies {
  local: CustomerReturnLocalInspectionReader;
  shopify: CustomerReturnShopifySnapshotReader;
  dimensions: CustomerReturnPackageDimensionsReader;
  reportBoxDiagnostic?: ReturnBoxReporter;
  now: () => Date;
}

/** Administrator inspection only. The dependencies deliberately contain no write port. */
export class CustomerReturnLiveService {
  constructor(private readonly dependencies: CustomerReturnLiveDependencies) {}

  async getState(): Promise<CustomerReturnLiveState> {
    return this.boundary(async () => {
      const shops = await this.readShops();
      return customerReturnLiveStateSchema.parse({ mode: "admin_live", customerAccess: "disabled", effects: "none",
        shops: shops.map(shop => ({ channelId: shop.channelId, name: shop.displayName })) });
    });
  }

  async lookup(raw: unknown): Promise<CustomerReturnLiveOrder> {
    return this.boundary(() => this.load(parseInput(customerReturnLiveLookupInputSchema, raw)));
  }

  async review(raw: unknown): Promise<CustomerReturnLiveReview> {
    return this.boundary(async () => {
      const input = parseInput(customerReturnLiveReviewInputSchema, raw);
      const order = await this.load({ channelId: input.channelId, orderReference: input.orderReference });
      if (order.sourceRevision !== input.sourceRevision) throw changed();
      const plan = validateCustomerReturnBoxPlan(order.lines, { selections: input.selections, parcels: input.parcels }, order.boxOptions);
      return customerReturnLiveReviewSchema.parse({ mode: "admin_live", sourceRevision: order.sourceRevision,
        effects: "none", orderReference: order.orderReference, ...plan, refundMethod: "manual_shopify" });
    });
  }

  private async readShops() {
    const shops = z.array(customerReturnInspectionShopSchema).max(20).parse(await this.dependencies.local.listShops());
    if (new Set(shops.map(shop => shop.channelId)).size !== shops.length
      || new Set(shops.map(shop => shop.connectionId)).size !== shops.length
      || new Set(shops.map(shop => shop.shopDomain)).size !== shops.length) throw unavailable();
    return shops;
  }

  private async load(input: CustomerReturnLiveLookupInput): Promise<CustomerReturnLiveOrder> {
    const reference = normalizeCustomerReturnOrderReference(input.orderReference);
    const shop = (await this.readShops()).find(candidate => candidate.channelId === input.channelId);
    if (!shop) throw new CustomerReturnLiveError("RETURN_LIVE_SHOP_UNAVAILABLE", "Select a configured returns store.", 409);
    const lookup = { channelId: shop.channelId, connectionId: shop.connectionId, orderReference: input.orderReference };
    const firstRaw = await this.dependencies.local.read(lookup);
    if (firstRaw === null) throw new CustomerReturnLiveError("RETURN_LIVE_ORDER_NOT_FOUND", "We couldn't find that order in the selected store.", 404);
    const first = customerReturnLocalInspectionSnapshotSchema.parse(firstRaw);
    if (canonical(first.shop) !== canonical(shop) || first.order.channelId !== shop.channelId
      || sourceOrderReference(first.order.externalOrderNumber) !== reference) throw unavailable();
    // Release the local read transaction before provider I/O. A second local
    // observation detects changed claims/scope while Shopify was being read.
    const provider = customerReturnShopifySnapshotSchema.parse(await this.dependencies.shopify.read({
      shop, externalOrderId: first.order.externalOrderId,
    }));
    verifyIdentity(first, provider, reference);
    const boxOptions = await readCustomerReturnOriginalBoxes(first, this.dependencies.dimensions, this.dependencies.reportBoxDiagnostic);
    const finalRaw = await this.dependencies.local.read(lookup);
    if (finalRaw === null) throw changed();
    const local = customerReturnLocalInspectionSnapshotSchema.parse(finalRaw);
    if (canonical(first) !== canonical(local)) throw changed();
    const now = this.dependencies.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw unavailable();
    for (const observedAt of [first.observedAt, local.observedAt, provider.observedAt]) {
      const age = now.getTime() - Date.parse(observedAt);
      if (age < 0 || age > MAX_OBSERVATION_AGE_MS) throw changed();
    }
    verifyIdentity(local, provider, reference);
    const claims = readCustomerReturnLiveClaims(local, provider);
    const delivery = projectCustomerReturnLiveDelivery({ shopify: provider, local });
    const policy = { channelId: shop.channelId, version: POLICY_VERSION, returnWindowDays: DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS };
    const facts: CustomerReturnEligibilityInput = {
      now: now.toISOString(), policy,
      order: { orderId: provider.order.id, channelId: shop.channelId, provider: "shopify",
        destinationCountryCode: provider.order.destinationCountryCode, purchasedAt: provider.order.createdAt,
        lines: provider.lines.map(line => ({ lineId: line.id, sku: line.sku, requiresShipping: line.requiresShipping,
          purchasedQuantity: line.quantity, claims: claims.get(line.id)!.claims,
          allocations: provider.fulfillments.flatMap(fulfillment => fulfillment.lines.filter(item => item.lineItemId === line.id && item.quantity > 0)
            .map(item => ({ allocationId: item.id, fulfillmentId: fulfillment.id, fulfillmentLineItemId: item.id,
              quantity: item.quantity, status: fulfillment.status === "SUCCESS" ? "active" as const : "cancelled" as const,
              deliveryEvidence: delivery.get(item.id)?.blocked ? [] : (delivery.get(item.id)?.evidence ?? []), staffDeliveryOverride: null }))),
        })),
      },
    };
    const eligibility = evaluateCustomerReturnEligibility(facts);
    const cancelled = local.order.cancelledAt !== null || provider.order.cancelledAt !== null;
    const lines = eligibility.lines.map(line => {
      const display = provider.lines.find(candidate => candidate.id === line.lineId)!;
      const known = claims.get(line.lineId)!;
      const blockedDelivery = line.allocations.some(allocation => allocation.sourceStatus === "active" && delivery.get(allocation.allocationId)?.blocked);
      const unexplainedQuantity = display.quantity - Math.min(display.currentQuantity, display.refundableQuantity) > known.reconciledRefundQuantity;
      const verificationNeeded = known.unresolved || unexplainedQuantity || known.unallocatedRefund;
      const unitWeightGrams = local.lines.find(candidate => candidate.externalLineItemId !== null
        && gid("LineItem", candidate.externalLineItemId) === line.lineId)!.unitWeightGrams;
      return { id: customerReturnPublicLineId(shop.channelId, provider.order.id, line.lineId),
        title: display.title, variant: display.variantTitle, sku: display.sku, unitWeightGrams,
        purchasedQuantity: line.purchasedQuantity, deliveredQuantity: line.deliveredQuantity,
        alreadyReturningQuantity: known.returningQuantity,
        eligibleQuantity: cancelled || verificationNeeded ? 0 : line.eligibleQuantity,
        message: verificationNeeded ? "These quantities need verification before a return can be started."
          : blockedDelivery ? "Some shipments need delivery verification. Only confirmed quantities are available to return."
          : liveLineMessage(line),
      };
    });
    const message = cancelled ? "This order has been canceled. Contact us for help with a return."
      : provider.order.destinationCountryCode !== "US" ? "This return portal is available for U.S. orders only." : null;
    // Optional provider measurements do not invalidate a custom box when a
    // dimension service recovers. Claimed original boxes are checked against
    // freshly read IDs and exact dimensions in validateCustomerReturnBoxPlan.
    const sourceRevision = createHash("sha256").update(canonical({ policy, local, provider, lines, message })).digest("hex");
    return customerReturnLiveOrderSchema.parse({ mode: "admin_live", sourceRevision, orderReference: reference,
      purchasedAt: provider.order.createdAt, evaluatedAt: eligibility.evaluatedAt,
      returnWindowEndsAt: eligibility.returnWindowEndsAt, message, lines, boxOptions });
  }

  private async boundary<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof CustomerReturnLiveError) throw error;
      if (error instanceof CustomerReturnOrderReferenceError) {
        throw new CustomerReturnLiveError("RETURN_LIVE_INPUT_INVALID", "Enter a valid order reference.", 400);
      }
      if (error instanceof CustomerReturnBoxPlanError) {
        throw new CustomerReturnLiveError(`RETURN_LIVE_${error.kind.toUpperCase()}_INVALID`, error.message,
          error.kind === "quantity" || error.kind === "weight" ? 409 : 400);
      }
      if (error instanceof CustomerReturnShopifySnapshotError) {
        throw new CustomerReturnLiveError(error.code, "The Shopify order could not be verified. Please try again.", error.code === "RETURN_SHOPIFY_INPUT_INVALID" ? 503 : error.status);
      }
      if (error instanceof CustomerReturnLocalInspectionError) {
        throw new CustomerReturnLiveError(error.code, "The order's return history could not be verified. Please try again.", 503);
      }
      throw unavailable();
    }
  }
}

// The existing Shopify ingestion writes created_at to OMS ordered_at. processedAt
// can differ for imported/backdated orders and is not that field's provenance.
function verifyIdentity(local: CustomerReturnLocalInspectionSnapshot, provider: CustomerReturnShopifySnapshot, reference: string): void {
  if (provider.shop.channelId !== local.shop.channelId || provider.shop.connectionId !== local.shop.connectionId
    || provider.shop.shopDomain !== local.shop.shopDomain || provider.order.id !== gid("Order", local.order.externalOrderId)
    || sourceOrderReference(provider.order.name) !== reference
    || Date.parse(provider.order.createdAt) !== Date.parse(local.order.purchasedAt)
    || provider.order.destinationCountryCode !== local.order.shipToCountry
    || local.lines.length !== provider.lines.length) throw unavailable();
  const localIds = new Set<string>();
  for (const line of local.lines) {
    if (!line.externalLineItemId) throw unavailable();
    const id = gid("LineItem", line.externalLineItemId);
    const source = provider.lines.find(candidate => candidate.id === id);
    if (localIds.has(id) || !source || source.quantity !== line.quantity
      || (line.requiresShipping !== null && source.requiresShipping !== line.requiresShipping)) throw unavailable();
    localIds.add(id);
  }
}

function liveLineMessage(line: CustomerReturnEligibilityOutput["lines"][number]): string | null {
  if (line.reasons.includes("return_window_elapsed")) return "The 365-day return window has ended.";
  if (line.reasons.includes("non_physical_item")) return "This item does not require a return shipment.";
  if (line.reasons.some(reason => ["delivery_evidence_conflict", "claim_allocation_unknown", "claim_on_inactive_allocation"].includes(reason))) {
    return "These quantities need verification before a return can be started.";
  }
  if (line.claimedQuantity === line.purchasedQuantity && line.claimedQuantity > 0) return "These items are already in a return.";
  if (line.deliveredQuantity === 0) return "Delivery has not been confirmed for these items yet.";
  if (line.deliveredQuantity < line.purchasedQuantity) return "Only the confirmed delivered quantity is available to return.";
  if (line.claimedQuantity > 0) return "Some of these items are already in a return.";
  return null;
}

function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new CustomerReturnLiveError("RETURN_LIVE_INPUT_INVALID", "The return request is invalid.", 400);
  return result.data;
}

/** Evidence order and observation time are not semantic changes. Event/source times remain bound. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([key]) => key !== "observedAt")
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function sourceOrderReference(raw: string): string {
  try { return normalizeCustomerReturnOrderReference(raw); } catch { throw unavailable(); }
}
function changed(): CustomerReturnLiveError {
  return new CustomerReturnLiveError("RETURN_LIVE_REVIEW_CHANGED", "This order changed. Reload it and choose your items again.", 409);
}
function unavailable(): CustomerReturnLiveError {
  return new CustomerReturnLiveError("RETURN_LIVE_DATA_UNVERIFIED", "The order data could not be verified. Please try again.", 503);
}
