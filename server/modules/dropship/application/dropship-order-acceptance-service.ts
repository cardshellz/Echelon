import { createHash } from "crypto";
import {
  CentsSchema,
  PositiveCentsSchema,
} from "../../../../shared/validation/currency";
import { DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type { NormalizedDropshipOrderPayload } from "./dropship-order-intake-service";
import {
  acceptDropshipOrderInputSchema,
  type AcceptDropshipOrderInput,
} from "./dropship-use-case-dtos";

export type DropshipOrderAcceptanceOutcome = "accepted" | "payment_hold";

export interface DropshipOrderAcceptanceInput extends AcceptDropshipOrderInput {
  requestHash: string;
  acceptedAt: Date;
}

export interface DropshipOrderAcceptanceResult {
  outcome: DropshipOrderAcceptanceOutcome;
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  shippingQuoteSnapshotId: number;
  omsOrderId: number | null;
  walletLedgerEntryId: number | null;
  economicsSnapshotId: number | null;
  totalDebitCents: number;
  currency: string;
  paymentHoldExpiresAt: Date | null;
  idempotentReplay: boolean;
}

export interface DropshipOrderAcceptanceRepository {
  acceptOrder(input: DropshipOrderAcceptanceInput): Promise<DropshipOrderAcceptanceResult>;
}

export interface DropshipAcceptanceIntakeRecord {
  intakeId: number;
  channelId: number;
  vendorId: number;
  storeConnectionId: number;
  platform: "ebay" | "shopify";
  externalOrderId: string;
  externalOrderNumber: string | null;
  status: string;
  normalizedPayload: NormalizedDropshipOrderPayload;
  rawPayload: Record<string, unknown>;
  omsOrderId: number | null;
  paymentHoldExpiresAt: Date | null;
}

export interface DropshipAcceptanceVendorContext {
  vendorId: number;
  memberId: string;
  currentPlanId: string | null;
  membershipPlanId: string | null;
  membershipPlanTier: string | null;
  vendorStatus: string;
  entitlementStatus: string;
  storeConnectionId: number;
  storeStatus: string;
  channelDiscountPercent: number;
}

export interface DropshipAcceptanceQuoteSnapshot {
  quoteSnapshotId: number;
  vendorId: number;
  storeConnectionId: number;
  warehouseId: number;
  currency: string;
  destinationCountry: string;
  destinationPostalCode: string | null;
  packageCount: number;
  totalShippingCents: number;
  insurancePoolCents: number;
  quotePayload: Record<string, unknown>;
}

export interface DropshipAcceptanceLineContext {
  lineIndex: number;
  listingId: number;
  productId: number;
  productVariantId: number;
  productLineIds: number[];
  sku: string | null;
  title: string;
  category: string | null;
  quantity: number;
  catalogRetailPriceCents: number;
  observedRetailUnitPriceCents: number;
  wholesaleUnitCostCents: number;
  externalLineItemId: string | null;
}

export interface DropshipAcceptancePricingPolicy {
  id: number;
  scopeType: "catalog" | "product_line" | "category" | "product" | "variant";
  productLineId: number | null;
  productId: number | null;
  productVariantId: number | null;
  category: string | null;
  mode: "off" | "warn_only" | "block_listing_push" | "block_order_acceptance";
  floorPriceCents: number | null;
  ceilingPriceCents: number | null;
}

export interface DropshipAcceptanceInventoryAvailability {
  productVariantId: number;
  availableQty: number;
}

export interface DropshipAcceptanceWalletState {
  walletAccountId: number;
  availableBalanceCents: number;
  pendingBalanceCents: number;
  currency: string;
}

export interface DropshipAcceptancePlanningInput {
  intake: DropshipAcceptanceIntakeRecord;
  vendor: DropshipAcceptanceVendorContext;
  quote: DropshipAcceptanceQuoteSnapshot;
  lines: DropshipAcceptanceLineContext[];
  pricingPolicies: DropshipAcceptancePricingPolicy[];
  inventory: DropshipAcceptanceInventoryAvailability[];
  wallet: DropshipAcceptanceWalletState;
  paymentHoldTimeoutMinutes: number;
  requestHash: string;
  idempotencyKey: string;
  acceptedAt: Date;
}

export interface DropshipOrderAcceptancePlan {
  outcome: DropshipOrderAcceptanceOutcome;
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  channelId: number;
  shippingQuoteSnapshotId: number;
  warehouseId: number;
  acceptedAt: Date;
  currency: string;
  omsExternalOrderId: string;
  externalOrderNumber: string | null;
  shipTo: Required<NonNullable<NormalizedDropshipOrderPayload["shipTo"]>>;
  lines: Array<DropshipAcceptanceLineContext & {
    retailLineTotalCents: number;
    wholesaleLineTotalCents: number;
  }>;
  retailSubtotalCents: number;
  wholesaleSubtotalCents: number;
  shippingCents: number;
  insurancePoolCents: number;
  feesCents: number;
  totalDebitCents: number;
  paymentHoldExpiresAt: Date | null;
  pricingSnapshot: Record<string, unknown>;
}

export class DropshipOrderAcceptanceService {
  constructor(
    private readonly deps: {
      repository: DropshipOrderAcceptanceRepository;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async acceptOrder(input: unknown): Promise<DropshipOrderAcceptanceResult> {
    const parsed = parseOrderAcceptanceInput(input);
    const acceptedAt = this.deps.clock.now();
    const requestHash = hashDropshipOrderAcceptanceRequest(parsed);
    const result = await this.deps.repository.acceptOrder({
      ...parsed,
      acceptedAt,
      requestHash,
    });

    this.deps.logger.info({
      code: result.outcome === "accepted"
        ? "DROPSHIP_ORDER_ACCEPTED"
        : "DROPSHIP_ORDER_PAYMENT_HOLD",
      message: result.outcome === "accepted"
        ? "Dropship order intake was accepted into OMS/WMS."
        : "Dropship order intake was placed on payment hold.",
      context: {
        intakeId: result.intakeId,
        vendorId: result.vendorId,
        storeConnectionId: result.storeConnectionId,
        shippingQuoteSnapshotId: result.shippingQuoteSnapshotId,
        omsOrderId: result.omsOrderId,
        walletLedgerEntryId: result.walletLedgerEntryId,
        economicsSnapshotId: result.economicsSnapshotId,
        totalDebitCents: result.totalDebitCents,
        idempotentReplay: result.idempotentReplay,
      },
    });

    return result;
  }
}

export function buildDropshipOrderAcceptancePlan(
  input: DropshipAcceptancePlanningInput,
): DropshipOrderAcceptancePlan {
  assertAcceptableIntakeStatus(input.intake);
  assertVendorAndStoreCanAccept(input.vendor);
  assertQuoteBelongsToOrder(input);

  const shipTo = requireCompleteShipTo(input.intake.normalizedPayload.shipTo);
  assertQuoteDestinationMatchesShipTo(input.quote, shipTo);
  assertQuoteItemsMatchOrder(input.quote, input.lines);
  assertPricingPoliciesAllowAcceptance(input.lines, input.pricingPolicies);
  assertInventoryCanReserve(input.lines, input.inventory);
  assertWalletCurrencyMatchesQuote(input.wallet, input.quote);

  const lines = input.lines.map((line) => ({
    ...line,
    retailLineTotalCents: multiplyCents(line.observedRetailUnitPriceCents, line.quantity),
    wholesaleLineTotalCents: multiplyCents(line.wholesaleUnitCostCents, line.quantity),
  }));
  const retailSubtotalCents = sumCents(lines.map((line) => line.retailLineTotalCents));
  const wholesaleSubtotalCents = sumCents(lines.map((line) => line.wholesaleLineTotalCents));
  const shippingCents = requireCents(input.quote.totalShippingCents, "quote.totalShippingCents");
  const insurancePoolCents = requireCents(input.quote.insurancePoolCents, "quote.insurancePoolCents");
  const feesCents = 0;
  const totalDebitCents = sumCents([wholesaleSubtotalCents, shippingCents, feesCents]);
  if (totalDebitCents <= 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_TOTAL_DEBIT_REQUIRED",
      "Dropship order acceptance requires a positive wallet debit.",
      { intakeId: input.intake.intakeId },
    );
  }

  const activePaymentHoldExpiresAt = normalizeActivePaymentHoldExpiresAt(input.intake, input.acceptedAt);
  const paymentHoldExpiresAt = input.wallet.availableBalanceCents >= totalDebitCents
    ? null
    : activePaymentHoldExpiresAt
      ?? new Date(input.acceptedAt.getTime() + normalizePaymentHoldTimeout(input.paymentHoldTimeoutMinutes) * 60_000);

  return {
    outcome: paymentHoldExpiresAt ? "payment_hold" : "accepted",
    intakeId: input.intake.intakeId,
    vendorId: input.intake.vendorId,
    storeConnectionId: input.intake.storeConnectionId,
    channelId: input.intake.channelId,
    shippingQuoteSnapshotId: input.quote.quoteSnapshotId,
    warehouseId: input.quote.warehouseId,
    acceptedAt: input.acceptedAt,
    currency: input.quote.currency,
    omsExternalOrderId: buildDropshipOmsExternalOrderId(input.intake),
    externalOrderNumber: input.intake.externalOrderNumber,
    shipTo,
    lines,
    retailSubtotalCents,
    wholesaleSubtotalCents,
    shippingCents,
    insurancePoolCents,
    feesCents,
    totalDebitCents,
    paymentHoldExpiresAt,
    pricingSnapshot: {
      version: 1,
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
      membership: {
        memberId: input.vendor.memberId,
        planId: input.vendor.membershipPlanId ?? input.vendor.currentPlanId,
        tier: input.vendor.membershipPlanTier,
      },
      wholesale: {
        channelDiscountPercent: input.vendor.channelDiscountPercent,
        lines: lines.map((line) => ({
          productVariantId: line.productVariantId,
          quantity: line.quantity,
          catalogRetailPriceCents: line.catalogRetailPriceCents,
          observedRetailUnitPriceCents: line.observedRetailUnitPriceCents,
          wholesaleUnitCostCents: line.wholesaleUnitCostCents,
          wholesaleLineTotalCents: line.wholesaleLineTotalCents,
        })),
      },
      shipping: {
        quoteSnapshotId: input.quote.quoteSnapshotId,
        packageCount: input.quote.packageCount,
        shippingCents,
        insurancePoolCents,
      },
      totals: {
        retailSubtotalCents,
        wholesaleSubtotalCents,
        feesCents,
        totalDebitCents,
      },
    },
  };
}

export function calculateDiscountedWholesaleUnitCostCents(
  catalogRetailPriceCents: number,
  discountPercent: number,
): number {
  const retail = requirePositiveCents(catalogRetailPriceCents, "catalogRetailPriceCents");
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new DropshipError(
      "DROPSHIP_WHOLESALE_DISCOUNT_INVALID",
      "Dropship wholesale discount percent must be an integer from 0 to 100.",
      { discountPercent },
    );
  }
  return retail - Math.floor((retail * discountPercent) / 100);
}

export function hashDropshipOrderAcceptanceRequest(input: AcceptDropshipOrderInput): string {
  return createHash("sha256").update(JSON.stringify({
    intakeId: input.intakeId,
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    shippingQuoteSnapshotId: input.shippingQuoteSnapshotId,
  })).digest("hex");
}

export function makeDropshipOrderAcceptanceLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipOrderAcceptanceEvent("info", event),
    warn: (event) => logDropshipOrderAcceptanceEvent("warn", event),
    error: (event) => logDropshipOrderAcceptanceEvent("error", event),
  };
}

export const systemDropshipOrderAcceptanceClock: DropshipClock = {
  now: () => new Date(),
};

function parseOrderAcceptanceInput(input: unknown): AcceptDropshipOrderInput {
  const result = acceptDropshipOrderInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_ORDER_ACCEPTANCE_INVALID_INPUT",
      "Dropship order acceptance input failed validation.",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

function assertAcceptableIntakeStatus(intake: DropshipAcceptanceIntakeRecord): void {
  if (["received", "retrying", "failed", "payment_hold", "processing"].includes(intake.status)) {
    return;
  }
  throw new DropshipError(
    "DROPSHIP_ORDER_INTAKE_NOT_ACCEPTABLE",
    "Dropship order intake is not in a status that can be accepted.",
    { intakeId: intake.intakeId, status: intake.status },
  );
}

function assertVendorAndStoreCanAccept(vendor: DropshipAcceptanceVendorContext): void {
  if (vendor.vendorStatus !== "active") {
    throw new DropshipError(
      "DROPSHIP_ORDER_VENDOR_BLOCKED",
      "Dropship vendor status does not allow order acceptance.",
      { vendorId: vendor.vendorId, vendorStatus: vendor.vendorStatus },
    );
  }
  if (vendor.entitlementStatus !== "active") {
    throw new DropshipError(
      "DROPSHIP_ORDER_ENTITLEMENT_BLOCKED",
      "Dropship vendor entitlement does not allow order acceptance.",
      { vendorId: vendor.vendorId, entitlementStatus: vendor.entitlementStatus },
    );
  }
  if (vendor.storeStatus !== "connected") {
    throw new DropshipError(
      "DROPSHIP_ORDER_STORE_BLOCKED",
      "Dropship store connection does not allow order acceptance.",
      { storeConnectionId: vendor.storeConnectionId, storeStatus: vendor.storeStatus },
    );
  }
}

function assertQuoteBelongsToOrder(input: DropshipAcceptancePlanningInput): void {
  if (
    input.quote.vendorId !== input.intake.vendorId
    || input.quote.storeConnectionId !== input.intake.storeConnectionId
    || input.quote.quoteSnapshotId <= 0
  ) {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIPPING_QUOTE_MISMATCH",
      "Dropship shipping quote does not belong to the order intake vendor/store.",
      {
        intakeId: input.intake.intakeId,
        quoteSnapshotId: input.quote.quoteSnapshotId,
        quoteVendorId: input.quote.vendorId,
        quoteStoreConnectionId: input.quote.storeConnectionId,
      },
    );
  }
}

function requireCompleteShipTo(
  shipTo: NormalizedDropshipOrderPayload["shipTo"],
): Required<NonNullable<NormalizedDropshipOrderPayload["shipTo"]>> {
  const required = ["name", "address1", "city", "region", "postalCode", "country"] as const;
  if (!shipTo) {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIPPING_ADDRESS_REQUIRED",
      "Dropship order acceptance requires a complete ship-to address.",
      { missingFields: required },
    );
  }
  const missing = required.filter((field) => !shipTo?.[field]?.trim());
  if (missing.length > 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIPPING_ADDRESS_REQUIRED",
      "Dropship order acceptance requires a complete ship-to address.",
      { missingFields: missing },
    );
  }
  return {
    name: shipTo.name!.trim(),
    company: shipTo.company?.trim() ?? "",
    address1: shipTo.address1!.trim(),
    address2: shipTo.address2?.trim() ?? "",
    city: shipTo.city!.trim(),
    region: shipTo.region!.trim(),
    postalCode: shipTo.postalCode!.trim(),
    country: shipTo.country!.trim().toUpperCase(),
    phone: shipTo.phone?.trim() ?? "",
    email: shipTo.email?.trim() ?? "",
  };
}

function assertQuoteDestinationMatchesShipTo(
  quote: DropshipAcceptanceQuoteSnapshot,
  shipTo: Required<NonNullable<NormalizedDropshipOrderPayload["shipTo"]>>,
): void {
  const quoteCountry = normalizeCountry(quote.destinationCountry);
  const shipToCountry = normalizeCountry(shipTo.country);
  const quotePostalCode = normalizePostalCode(quote.destinationPostalCode);
  const shipToPostalCode = normalizePostalCode(shipTo.postalCode);
  if (quoteCountry !== shipToCountry || (quotePostalCode && quotePostalCode !== shipToPostalCode)) {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIPPING_QUOTE_DESTINATION_MISMATCH",
      "Dropship shipping quote destination does not match the accepted order destination.",
      {
        quoteSnapshotId: quote.quoteSnapshotId,
        quoteCountry,
        quotePostalCode,
        shipToCountry,
        shipToPostalCode,
      },
    );
  }
}

function assertQuoteItemsMatchOrder(
  quote: DropshipAcceptanceQuoteSnapshot,
  lines: readonly DropshipAcceptanceLineContext[],
): void {
  const quoteItems = readQuotePayloadItems(quote.quotePayload);
  const quoteQtyByVariant = aggregateQuantityByVariant(quoteItems);
  const orderQtyByVariant = aggregateQuantityByVariant(lines.map((line) => ({
    productVariantId: line.productVariantId,
    quantity: line.quantity,
  })));
  if (!quantityMapsEqual(quoteQtyByVariant, orderQtyByVariant)) {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIPPING_QUOTE_ITEMS_MISMATCH",
      "Dropship shipping quote items do not match the order acceptance items.",
      {
        quoteSnapshotId: quote.quoteSnapshotId,
        quoteItems: Object.fromEntries(quoteQtyByVariant),
        orderItems: Object.fromEntries(orderQtyByVariant),
      },
    );
  }
}

function assertPricingPoliciesAllowAcceptance(
  lines: readonly DropshipAcceptanceLineContext[],
  policies: readonly DropshipAcceptancePricingPolicy[],
): void {
  const blockers: string[] = [];
  for (const line of lines) {
    for (const policy of policies.filter((row) => pricingPolicyMatchesLine(row, line))) {
      if (policy.mode !== "block_order_acceptance") continue;
      const belowFloor = policy.floorPriceCents !== null
        && line.observedRetailUnitPriceCents < policy.floorPriceCents;
      const aboveCeiling = policy.ceilingPriceCents !== null
        && line.observedRetailUnitPriceCents > policy.ceilingPriceCents;
      if (belowFloor || aboveCeiling) {
        blockers.push(`policy_${policy.id}:${line.productVariantId}:${belowFloor ? "below_floor" : "above_ceiling"}`);
      }
    }
  }
  if (blockers.length > 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_PRICING_POLICY_BLOCKED",
      "Dropship order acceptance is blocked by pricing policy.",
      { blockers },
    );
  }
}

function assertInventoryCanReserve(
  lines: readonly DropshipAcceptanceLineContext[],
  inventory: readonly DropshipAcceptanceInventoryAvailability[],
): void {
  const availableByVariant = new Map(inventory.map((row) => [row.productVariantId, row.availableQty]));
  const requiredByVariant = aggregateQuantityByVariant(lines.map((line) => ({
    productVariantId: line.productVariantId,
    quantity: line.quantity,
  })));
  const shortfalls: Array<{ productVariantId: number; requiredQty: number; availableQty: number }> = [];
  for (const [productVariantId, requiredQty] of requiredByVariant) {
    const availableQty = Math.max(0, availableByVariant.get(productVariantId) ?? 0);
    if (availableQty < requiredQty) {
      shortfalls.push({ productVariantId, requiredQty, availableQty });
    }
  }
  if (shortfalls.length > 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_INVENTORY_SHORTFALL",
      "Dropship order acceptance cannot reserve all required inventory.",
      { shortfalls },
    );
  }
}

function assertWalletCurrencyMatchesQuote(
  wallet: DropshipAcceptanceWalletState,
  quote: DropshipAcceptanceQuoteSnapshot,
): void {
  if (wallet.currency !== quote.currency) {
    throw new DropshipError(
      "DROPSHIP_ORDER_WALLET_CURRENCY_MISMATCH",
      "Dropship wallet currency does not match the accepted shipping quote currency.",
      { walletCurrency: wallet.currency, quoteCurrency: quote.currency },
    );
  }
}

function pricingPolicyMatchesLine(
  policy: DropshipAcceptancePricingPolicy,
  line: DropshipAcceptanceLineContext,
): boolean {
  switch (policy.scopeType) {
    case "catalog":
      return true;
    case "product_line":
      return typeof policy.productLineId === "number" && line.productLineIds.includes(policy.productLineId);
    case "category":
      return normalizeString(policy.category) !== null && normalizeString(policy.category) === normalizeString(line.category);
    case "product":
      return policy.productId === line.productId;
    case "variant":
      return policy.productVariantId === line.productVariantId;
    default:
      return false;
  }
}

function readQuotePayloadItems(payload: Record<string, unknown>): Array<{ productVariantId: number; quantity: number }> {
  const items = payload.items;
  if (!Array.isArray(items)) {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIPPING_QUOTE_ITEMS_REQUIRED",
      "Dropship shipping quote snapshot is missing item details.",
    );
  }
  return items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new DropshipError(
        "DROPSHIP_ORDER_SHIPPING_QUOTE_ITEMS_INVALID",
        "Dropship shipping quote snapshot contains an invalid item.",
        { index },
      );
    }
    const row = item as { productVariantId?: unknown; quantity?: unknown };
    const productVariantId =
      typeof row.productVariantId === "number" && Number.isInteger(row.productVariantId) && row.productVariantId > 0
        ? row.productVariantId
        : null;
    if (productVariantId === null) {
      throw new DropshipError(
        "DROPSHIP_ORDER_SHIPPING_QUOTE_ITEMS_INVALID",
        "Dropship shipping quote item is missing productVariantId.",
        { index },
      );
    }
    const quantity =
      typeof row.quantity === "number" && Number.isInteger(row.quantity) && row.quantity > 0
        ? row.quantity
        : null;
    if (quantity === null) {
      throw new DropshipError(
        "DROPSHIP_ORDER_SHIPPING_QUOTE_ITEMS_INVALID",
        "Dropship shipping quote item is missing quantity.",
        { index },
      );
    }
    return {
      productVariantId,
      quantity,
    };
  });
}

function aggregateQuantityByVariant(
  items: ReadonlyArray<{ productVariantId: number; quantity: number }>,
): Map<number, number> {
  const result = new Map<number, number>();
  for (const item of items) {
    result.set(item.productVariantId, (result.get(item.productVariantId) ?? 0) + item.quantity);
  }
  return result;
}

function quantityMapsEqual(left: Map<number, number>, right: Map<number, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function buildDropshipOmsExternalOrderId(intake: DropshipAcceptanceIntakeRecord): string {
  return `dropship:${intake.storeConnectionId}:${intake.externalOrderId}`;
}

function normalizePaymentHoldTimeout(value: number): number {
  return Number.isInteger(value) && value > 0
    ? value
    : DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES;
}

function normalizeActivePaymentHoldExpiresAt(
  intake: DropshipAcceptanceIntakeRecord,
  acceptedAt: Date,
): Date | null {
  if (intake.status !== "payment_hold") {
    return null;
  }
  if (!intake.paymentHoldExpiresAt) {
    throw new DropshipError(
      "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRY_REQUIRED",
      "Dropship payment hold intake is missing its expiration timestamp.",
      { intakeId: intake.intakeId },
    );
  }
  if (intake.paymentHoldExpiresAt <= acceptedAt) {
    throw new DropshipError(
      "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED",
      "Dropship payment hold expired before order acceptance.",
      {
        intakeId: intake.intakeId,
        paymentHoldExpiresAt: intake.paymentHoldExpiresAt.toISOString(),
      },
    );
  }
  return intake.paymentHoldExpiresAt;
}

function multiplyCents(amountCents: number, multiplier: number): number {
  requireCents(amountCents, "amountCents");
  if (!Number.isInteger(multiplier) || multiplier <= 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_QUANTITY_INVALID",
      "Dropship order quantity must be a positive integer.",
      { multiplier },
    );
  }
  return amountCents * multiplier;
}

function sumCents(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + requireCents(value, "amountCents"), 0);
}

function requireCents(value: number, field: string): number {
  const result = CentsSchema.safeParse(value);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_ORDER_MONEY_INVALID",
      "Dropship order money values must be integer cents.",
      { field, value },
    );
  }
  return result.data;
}

function requirePositiveCents(value: number, field: string): number {
  const result = PositiveCentsSchema.safeParse(value);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_ORDER_MONEY_INVALID",
      "Dropship order money values must be positive integer cents.",
      { field, value },
    );
  }
  return result.data;
}

function normalizeCountry(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function normalizePostalCode(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeString(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function logDropshipOrderAcceptanceEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}
