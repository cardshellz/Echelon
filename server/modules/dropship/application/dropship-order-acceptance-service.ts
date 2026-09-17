import { createHash } from "crypto";
import {
  CentsSchema,
  PositiveCentsSchema,
} from "../../../../shared/validation/currency";
import { DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import { vendorOrderAdmissionFor } from "../domain/vendor-standing";
import {
  ACCEPTANCE_COST_AUTHORITY,
  buildAcceptanceCostEvidenceHash,
  type DropshipAcceptanceProductCostEvidence,
} from "../domain/order-acceptance-cost";
import {
  formatNotificationCurrency,
  sendDropshipNotificationSafely,
} from "./dropship-notification-dispatch";
import type {
  DropshipCanonicalAcceptanceFulfillment,
  DropshipClock,
  DropshipInventoryRuntimeAuthorityGate,
  DropshipLogEvent,
  DropshipLogger,
} from "./dropship-ports";
import type { DropshipNotificationSender } from "./dropship-ports";
import type { NormalizedDropshipOrderPayload } from "./dropship-order-intake-service";
import {
  acceptDropshipOrderInputSchema,
  type AcceptDropshipOrderInput,
} from "./dropship-use-case-dtos";

export type DropshipOrderAcceptanceOutcome = "accepted" | "payment_hold";

/**
 * Why an order is held. `insufficient_balance`: the wallet cannot cover the
 * debit. `vendor_paused`: the vendor is paused for a funding reason, so the
 * order waits whatever the balance until the wallet is funded to the
 * minimum and the vendor resumes.
 */
export type DropshipPaymentHoldReason = "insufficient_balance" | "vendor_paused";

/**
 * What happened to the wallet top-up attempted for a held order in the same
 * worker pass, so the one hold notice can say it. Null when no top-up was
 * attempted or it changed nothing worth telling.
 */
export type DropshipAcceptanceReloadContext =
  | { kind: "pending"; amountCents: number; currency: string }
  | { kind: "declined"; detail: string | null }
  | { kind: "failed"; message: string }
  | { kind: "skipped"; reason: string };

export interface DropshipAcceptanceNoticeContext {
  reload?: DropshipAcceptanceReloadContext | null;
}

export interface DropshipOrderAcceptanceOptions {
  /**
   * False when the caller orchestrates a whole pass (hold, top-up, retry) and
   * sends the pass's single outcome notice itself via notifyAcceptanceOutcome.
   * Default true: a stand-alone acceptance tells the vendor right away.
   */
  notify?: boolean;
}

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
  /** Set when outcome is `payment_hold` and the reason is known; null on replays that do not re-derive it. */
  paymentHoldReason: DropshipPaymentHoldReason | null;
  idempotentReplay: boolean;
}

export interface DropshipOrderAcceptanceRepository {
  acceptOrder(input: DropshipOrderAcceptanceInput): Promise<DropshipOrderAcceptanceResult>;
  prepareCanonicalOrder(
    input: DropshipOrderAcceptanceInput,
  ): Promise<DropshipCanonicalOrderAcceptancePreparation>;
  markCanonicalInventoryClaimed(input: {
    acceptance: DropshipOrderAcceptanceInput;
    omsOrderId: number;
    wmsOrderId: number;
    inventoryClaimId: string | null;
  }): Promise<void>;
  finalizeCanonicalOrder(
    input: DropshipOrderAcceptanceInput,
  ): Promise<DropshipOrderAcceptanceResult>;
  markCanonicalInventoryClaimReleased(input: {
    acceptance: DropshipOrderAcceptanceInput;
    omsOrderId: number;
    wmsOrderId: number;
    inventoryClaimId: string | null;
    reason: string;
  }): Promise<void>;
}

export interface DropshipCanonicalOrderAcceptancePrepared {
  outcome: "prepared";
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  shippingQuoteSnapshotId: number;
  warehouseId: number;
  omsOrderId: number;
  idempotentReplay: boolean;
}

export interface DropshipCanonicalOrderAcceptanceCompensationRequired {
  outcome: "compensation_required";
  result: DropshipOrderAcceptanceResult;
  omsOrderId: number;
  wmsOrderId: number;
  warehouseId: number;
  inventoryClaimId: string | null;
}

export type DropshipCanonicalOrderAcceptancePreparation =
  | DropshipCanonicalOrderAcceptancePrepared
  | DropshipCanonicalOrderAcceptanceCompensationRequired
  | DropshipOrderAcceptanceResult;

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
  /** Why the vendor is paused; null unless vendorStatus is `paused`. */
  vendorStandingReason: string | null;
  entitlementStatus: string;
  storeConnectionId: number;
  storeStatus: string;
  storeLaunchReady: boolean;
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
  /** The `.ops` plan cost for one sellable pack; the only basis for the wallet debit. */
  wholesaleUnitCostCents: number;
  /** Where wholesaleUnitCostCents came from; frozen into the economics snapshot. */
  productCostEvidence: DropshipAcceptanceProductCostEvidence;
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
  inventoryValidation: "legacy_exact_sku" | "canonical_claim";
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
  paymentHoldReason: DropshipPaymentHoldReason | null;
  /** Content hash of the cost inputs that produced the debit (see order-acceptance-cost). */
  costEvidenceHash: string;
  pricingSnapshot: Record<string, unknown>;
}

/** Bumped when the shape of pricingSnapshot changes; readers branch on it. */
export const DROPSHIP_PRICING_SNAPSHOT_VERSION = 2;

export class DropshipOrderAcceptanceService {
  constructor(
    private readonly deps: {
      repository: DropshipOrderAcceptanceRepository;
      inventoryAuthority: DropshipInventoryRuntimeAuthorityGate;
      canonicalFulfillment: DropshipCanonicalAcceptanceFulfillment;
      notificationSender?: DropshipNotificationSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async acceptOrder(input: unknown, options: DropshipOrderAcceptanceOptions = {}): Promise<DropshipOrderAcceptanceResult> {
    const parsed = parseOrderAcceptanceInput(input);
    const acceptedAt = this.deps.clock.now();
    const requestHash = hashDropshipOrderAcceptanceRequest(parsed);
    const acceptanceInput: DropshipOrderAcceptanceInput = {
      ...parsed,
      acceptedAt,
      requestHash,
    };
    const result = await this.deps.inventoryAuthority.execute((authority) =>
      authority === "legacy"
        ? this.deps.repository.acceptOrder(acceptanceInput)
        : this.acceptCanonicalOrder(acceptanceInput),
    );

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

    if (options.notify !== false) {
      await this.notifyAcceptanceOutcome(result);
    }
    return result;
  }

  private async acceptCanonicalOrder(
    input: DropshipOrderAcceptanceInput,
  ): Promise<DropshipOrderAcceptanceResult> {
    const preparation = await this.deps.repository.prepareCanonicalOrder(input);
    if (preparation.outcome === "compensation_required") {
      return this.completeCanonicalPaymentHoldCompensation(input, preparation);
    }
    if (preparation.outcome !== "prepared") {
      return preparation;
    }

    const { wmsOrderId, warehouseId, inventoryClaimId } = await this.deps.canonicalFulfillment
      .stageOmsOrderAndClaimInventory({
        omsOrderId: preparation.omsOrderId,
        expectedWarehouseId: preparation.warehouseId,
      });
    if (warehouseId !== preparation.warehouseId) {
      throw new DropshipError(
        "DROPSHIP_CANONICAL_WAREHOUSE_MISMATCH",
        "Canonical dropship acceptance staged inventory in a warehouse other than the frozen quote warehouse.",
        {
          intakeId: preparation.intakeId,
          omsOrderId: preparation.omsOrderId,
          expectedWarehouseId: preparation.warehouseId,
          stagedWarehouseId: warehouseId,
        },
      );
    }
    await this.deps.repository.markCanonicalInventoryClaimed({
      acceptance: input,
      omsOrderId: preparation.omsOrderId,
      wmsOrderId,
      inventoryClaimId,
    });

    const result = await this.deps.repository.finalizeCanonicalOrder(input);
    if (result.outcome !== "payment_hold") {
      return result;
    }

    return this.completeCanonicalPaymentHoldCompensation(input, {
      outcome: "compensation_required",
      result,
      omsOrderId: preparation.omsOrderId,
      wmsOrderId,
      warehouseId: preparation.warehouseId,
      inventoryClaimId,
    });
  }

  private async completeCanonicalPaymentHoldCompensation(
    input: DropshipOrderAcceptanceInput,
    preparation: DropshipCanonicalOrderAcceptanceCompensationRequired,
  ): Promise<DropshipOrderAcceptanceResult> {
    await this.deps.canonicalFulfillment.releaseStagedInventoryClaim({
      wmsOrderId: preparation.wmsOrderId,
      inventoryClaimId: preparation.inventoryClaimId,
      reason: `Dropship intake ${preparation.result.intakeId} entered payment hold before acceptance finalization`,
    });
    await this.deps.repository.markCanonicalInventoryClaimReleased({
      acceptance: input,
      omsOrderId: preparation.omsOrderId,
      wmsOrderId: preparation.wmsOrderId,
      inventoryClaimId: preparation.inventoryClaimId,
      reason: "wallet_balance_changed_before_finalization",
    });
    if (!preparation.result.paymentHoldExpiresAt) {
      throw new DropshipError(
        "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRY_REQUIRED",
        "Dropship payment hold intake is missing its expiration timestamp.",
        { intakeId: preparation.result.intakeId },
      );
    }
    if (preparation.result.paymentHoldExpiresAt <= input.acceptedAt) {
      throw new DropshipError(
        "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED",
        "Dropship payment hold expired before canonical acceptance could resume.",
        {
          intakeId: preparation.result.intakeId,
          paymentHoldExpiresAt: preparation.result.paymentHoldExpiresAt.toISOString(),
        },
      );
    }
    return preparation.result;
  }

  /**
   * The vendor's one notice for an acceptance outcome. A replay says nothing:
   * the vendor heard about that outcome when it first happened.
   */
  async notifyAcceptanceOutcome(
    result: DropshipOrderAcceptanceResult,
    context: DropshipAcceptanceNoticeContext = {},
  ): Promise<void> {
    if (result.idempotentReplay) {
      return;
    }

    const accepted = result.outcome === "accepted";
    const deadline = result.paymentHoldExpiresAt?.toISOString() ?? "the hold expires";
    const reload = context.reload ?? null;
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: result.vendorId,
      eventType: accepted ? "dropship_order_accepted" : "dropship_order_payment_hold",
      critical: !accepted,
      channels: ["email", "in_app"],
      title: accepted ? "Dropship order accepted" : "Dropship order needs wallet funding",
      message: accepted
        ? `Order intake ${result.intakeId} was accepted into fulfillment for ${formatNotificationCurrency(result.totalDebitCents, result.currency)}.`
        : result.paymentHoldReason === "vendor_paused"
          ? `Order intake ${result.intakeId} is waiting because selling is paused. Fund your wallet back to its minimum before ${deadline} and it will be accepted for ${formatNotificationCurrency(result.totalDebitCents, result.currency)}.`
          : `Order intake ${result.intakeId} is on payment hold and requires ${formatNotificationCurrency(result.totalDebitCents, result.currency)} before ${deadline}.${reloadSentenceFor(reload)}`,
      payload: {
        intakeId: result.intakeId,
        vendorId: result.vendorId,
        storeConnectionId: result.storeConnectionId,
        shippingQuoteSnapshotId: result.shippingQuoteSnapshotId,
        omsOrderId: result.omsOrderId,
        walletLedgerEntryId: result.walletLedgerEntryId,
        economicsSnapshotId: result.economicsSnapshotId,
        totalDebitCents: result.totalDebitCents,
        currency: result.currency,
        paymentHoldExpiresAt: result.paymentHoldExpiresAt?.toISOString() ?? null,
        paymentHoldReason: result.paymentHoldReason,
        reload,
      },
      idempotencyKey: `order-acceptance:${result.intakeId}:${result.outcome}`,
    }, {
      code: "DROPSHIP_ORDER_ACCEPTANCE_NOTIFICATION_FAILED",
      message: "Dropship order acceptance notification failed after acceptance transaction completed.",
      context: {
        intakeId: result.intakeId,
        vendorId: result.vendorId,
        storeConnectionId: result.storeConnectionId,
        outcome: result.outcome,
      },
    });
  }
}

/** The sentence a hold notice adds about the top-up tried in the same pass. */
function reloadSentenceFor(reload: DropshipAcceptanceReloadContext | null): string {
  if (!reload) return "";
  switch (reload.kind) {
    case "pending":
      return ` A bank top-up of ${formatNotificationCurrency(reload.amountCents, reload.currency)} is on its way; the order is accepted when it settles.`;
    case "declined":
      return ` We tried to charge your card for the shortfall and it was declined${reload.detail ? ` (${reload.detail.replace(/_/g, " ")})` : ""}. Add funds or update your card in Wallet.`;
    case "failed":
      return ` We could not top up your wallet automatically (${reload.message}); add funds to accept it sooner.`;
    case "skipped":
      return ` Auto-reload could not top it up: ${skipReasonPhraseFor(reload.reason)}. Add funds or check auto-reload in Wallet.`;
  }
}

function skipReasonPhraseFor(reason: string): string {
  switch (reason) {
    case "auto_reload_disabled":
      return "auto-reload is off";
    case "amount_exceeds_max_single_reload":
      return "the amount is over your single-reload limit";
    case "funding_method_required":
    case "funding_method_missing":
      return "there is no funding method to charge";
    case "funding_method_not_active":
    case "funding_method_provider_identity_required":
    case "funding_method_rail_unsupported":
      return "your saved funding method cannot be charged";
    default:
      return reason.replace(/_/g, " ");
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
  if (input.inventoryValidation === "legacy_exact_sku") {
    assertInventoryCanReserve(input.lines, input.inventory);
  }
  assertWalletCurrencyMatchesQuote(input.wallet, input.quote);

  const lines = input.lines.map((line) => ({
    ...line,
    retailLineTotalCents: multiplyCents(line.observedRetailUnitPriceCents, line.quantity),
    // The debit basis must be a positive .ops cost; a zero or negative cost never
    // reaches the plan (resolveAcceptanceUnitCost refuses it upstream too).
    wholesaleLineTotalCents: multiplyCents(
      requirePositiveCents(line.wholesaleUnitCostCents, "wholesaleUnitCostCents"),
      line.quantity,
    ),
  }));
  const costEvidenceHash = buildAcceptanceCostEvidenceHash({ vendorId: input.vendor.vendorId, lines });
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
  // A vendor paused for funding is held whatever the balance: no order is
  // accepted until the wallet is back to its minimum and the vendor resumes.
  const paymentHoldReason: DropshipPaymentHoldReason | null = vendorOrderAdmissionFor({
    status: input.vendor.vendorStatus,
    standingReason: input.vendor.vendorStandingReason,
  }) === "hold"
    ? "vendor_paused"
    : input.wallet.availableBalanceCents >= totalDebitCents
      ? null
      : "insufficient_balance";
  const paymentHoldExpiresAt = paymentHoldReason === null
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
    paymentHoldReason,
    costEvidenceHash,
    pricingSnapshot: {
      version: DROPSHIP_PRICING_SNAPSHOT_VERSION,
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
      membership: {
        memberId: input.vendor.memberId,
        planId: input.vendor.membershipPlanId ?? input.vendor.currentPlanId,
        tier: input.vendor.membershipPlanTier,
      },
      wholesale: {
        authority: ACCEPTANCE_COST_AUTHORITY,
        costResolvedAt: input.acceptedAt.toISOString(),
        costEvidenceHash,
        lines: lines.map((line) => ({
          productVariantId: line.productVariantId,
          quantity: line.quantity,
          catalogRetailPriceCents: line.catalogRetailPriceCents,
          observedRetailUnitPriceCents: line.observedRetailUnitPriceCents,
          wholesaleUnitCostCents: line.wholesaleUnitCostCents,
          wholesaleLineTotalCents: line.wholesaleLineTotalCents,
          costSource: line.productCostEvidence.source,
          costPlanId: line.productCostEvidence.planId,
          costOverrideId: line.productCostEvidence.overrideId,
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
  // Paused for funding is not blocked: the plan holds the order instead.
  if (vendorOrderAdmissionFor({ status: vendor.vendorStatus, standingReason: vendor.vendorStandingReason }) === "reject") {
    throw new DropshipError(
      "DROPSHIP_ORDER_VENDOR_BLOCKED",
      "Dropship vendor status does not allow order acceptance.",
      { vendorId: vendor.vendorId, vendorStatus: vendor.vendorStatus, vendorStandingReason: vendor.vendorStandingReason },
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
  if (!vendor.storeLaunchReady) {
    throw new DropshipError(
      "DROPSHIP_ORDER_STORE_BLOCKED",
      "Dropship store connection is not launch-ready for order acceptance.",
      { storeConnectionId: vendor.storeConnectionId, storeStatus: vendor.storeStatus, storeLaunchReady: false },
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
  if (!intake.paymentHoldExpiresAt) {
    if (intake.status === "payment_hold") {
      throw new DropshipError(
        "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRY_REQUIRED",
        "Dropship payment hold intake is missing its expiration timestamp.",
        { intakeId: intake.intakeId },
      );
    }
    return null;
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
