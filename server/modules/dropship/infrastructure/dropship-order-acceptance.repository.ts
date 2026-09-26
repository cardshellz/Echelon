import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import { vendorOrderAdmissionFor } from "../domain/vendor-standing";
import {
  decideAcceptanceFunding,
  type DropshipAcceptanceFundingDecision,
  type DropshipAdvanceContext,
  type DropshipAdvanceRefusal,
} from "../domain/acceptance-funding";
import { loadAdvancePolicyWithClient, loadAdvanceSourcesWithClient } from "./dropship-advance.reader";
import { reconcileRewardsLotsWithClient, takeRewardsFromLotsWithClient } from "./dropship-wallet-rewards-lots";
import { resolveAcceptanceUnitCost } from "../domain/order-acceptance-cost";
import { isDropshipStoreConnectionLaunchReady } from "../domain/store-connection";
import type { NormalizedDropshipOrderPayload } from "../application/dropship-order-intake-service";
import type { DropshipProductCostReader } from "../application/dropship-product-cost";
import { PgShellzClubProductCostAdapter } from "./shellz-club-product-cost.adapter";
import { isWarehouseEnabledForChannelWithClient } from "./dropship-oms-warehouse-assignments.reader";
import {
  buildDropshipOrderAcceptancePlan,
  DROPSHIP_PRICING_SNAPSHOT_VERSION,
  type DropshipAcceptanceIntakeRecord,
  type DropshipAcceptanceInventoryAvailability,
  type DropshipAcceptanceLineContext,
  type DropshipAcceptancePlanningInput,
  type DropshipAcceptancePricingPolicy,
  type DropshipAcceptanceQuoteSnapshot,
  type DropshipAcceptanceVendorContext,
  type DropshipAcceptanceWalletState,
  type DropshipCanonicalOrderAcceptancePreparation,
  type DropshipOrderAcceptanceAdvanceSummary,
  type DropshipOrderAcceptanceInput,
  type DropshipOrderAcceptancePlan,
  type DropshipOrderAcceptanceRepository,
  type DropshipOrderAcceptanceResult,
} from "../application/dropship-order-acceptance-service";

interface IntakeRow {
  id: number;
  channel_id: number;
  vendor_id: number;
  store_connection_id: number;
  platform: DropshipAcceptanceIntakeRecord["platform"];
  external_order_id: string;
  external_order_number: string | null;
  status: string;
  payment_hold_expires_at: Date | null;
  normalized_payload: NormalizedDropshipOrderPayload | null;
  raw_payload: Record<string, unknown> | null;
  oms_order_id: string | number | null;
}

interface VendorContextRow {
  vendor_id: number;
  member_id: string;
  current_plan_id: string | null;
  membership_plan_id: string | null;
  membership_plan_tier: string | null;
  vendor_status: string;
  vendor_standing_reason: string | null;
  entitlement_status: string;
  store_connection_id: number;
  store_platform: string;
  store_status: string;
  setup_status: string;
  access_token_ref: string | null;
  refresh_token_ref: string | null;
}

interface QuoteRow {
  id: number;
  vendor_id: number;
  store_connection_id: number | null;
  warehouse_id: number;
  currency: string;
  destination_country: string;
  destination_postal_code: string | null;
  package_count: number;
  total_shipping_cents: string | number;
  insurance_pool_cents: string | number;
  quote_payload: Record<string, unknown> | null;
}

interface ListingCandidateRow {
  listing_id: number;
  vendor_id: number;
  store_connection_id: number;
  product_id: number;
  product_variant_id: number;
  product_line_ids: number[] | null;
  listing_status: string;
  external_listing_id: string | null;
  external_offer_id: string | null;
  vendor_retail_price_cents: string | number | null;
  product_sku: string | null;
  variant_sku: string | null;
  product_name: string;
  variant_name: string;
  category: string | null;
  product_is_active: boolean;
  variant_is_active: boolean;
  sales_eligibility: "sellable" | "internal_only";
  dropship_eligible: boolean | null;
  catalog_retail_price_cents: string | number | null;
}

interface PricingPolicyRow {
  id: number;
  scope_type: DropshipAcceptancePricingPolicy["scopeType"];
  product_line_id: number | null;
  product_id: number | null;
  product_variant_id: number | null;
  category: string | null;
  mode: DropshipAcceptancePricingPolicy["mode"];
  floor_price_cents: string | number | null;
  ceiling_price_cents: string | number | null;
}

interface InventoryLevelRow {
  id: number;
  warehouse_location_id: number;
  product_variant_id: number;
  variant_qty: number;
  reserved_qty: number;
  picked_qty: number;
  packed_qty: number;
}

interface WalletAccountRow {
  id: number;
  vendor_id: number;
  available_balance_cents: string | number;
  pending_balance_cents: string | number;
  rewards_balance_cents: string | number;
  currency: string;
  status: string;
}

interface AutoReloadRow {
  payment_hold_timeout_minutes: number;
}

interface ExistingAcceptanceRow {
  id: number;
  shipping_quote_snapshot_id: number | null;
  total_debit_cents: string | number;
  currency: string;
  pricing_snapshot: Record<string, unknown> | null;
}

interface WalletLedgerIdRow {
  id: number;
}

interface OmsOrderRow {
  id: string | number;
}

interface OmsLineRow {
  id: string | number;
  product_variant_id: number;
  quantity: number;
}

interface CanonicalAcceptanceStageRow {
  intake_id: number;
  oms_order_id: string | number;
  vendor_id: number;
  store_connection_id: number;
  shipping_quote_snapshot_id: number;
  warehouse_id: number;
  wallet_account_id: number;
  state:
    | "prepared"
    | "inventory_claimed"
    | "compensation_pending"
    | "inventory_released"
    | "expired"
    | "finalized";
  claim_attempt_number: number | null;
  wms_order_id: string | number | null;
  request_hash: string;
  submitted_idempotency_key: string;
  actor_type: DropshipOrderAcceptanceInput["actor"]["actorType"];
  actor_id: string | null;
  member_id: string;
  membership_plan_id: string | null;
  currency: string;
  retail_subtotal_cents: string | number;
  wholesale_subtotal_cents: string | number;
  shipping_cents: string | number;
  insurance_pool_cents: string | number;
  fees_cents: string | number;
  total_debit_cents: string | number;
  cost_evidence_hash: string;
  pricing_snapshot: Record<string, unknown>;
  prepared_at: Date;
  inventory_claimed_at: Date | null;
  inventory_release_requested_at: Date | null;
  inventory_released_at: Date | null;
  inventory_release_reason: string | null;
  expired_at: Date | null;
  finalized_at: Date | null;
}

interface CanonicalClaimAttemptRow {
  intake_id: number;
  attempt_number: number;
  oms_order_id: string | number;
  wms_order_id: string | number;
  warehouse_id: number;
  claim_authority: "canonical";
  claim_owner: "dropship_acceptance";
  claim_outcome: "claimed" | "no_claim_required";
  availability_claim_id: string | number | null;
  state: "claimed" | "compensation_pending" | "released" | "expired" | "finalized";
  claimed_at: Date;
  release_requested_at: Date | null;
  released_at: Date | null;
  release_reason: string | null;
  expired_at: Date | null;
  finalized_at: Date | null;
}

type AcceptanceFinancialPlan = Pick<
  DropshipOrderAcceptancePlan,
  | "outcome"
  | "intakeId"
  | "vendorId"
  | "storeConnectionId"
  | "shippingQuoteSnapshotId"
  | "warehouseId"
  | "acceptedAt"
  | "currency"
  | "retailSubtotalCents"
  | "wholesaleSubtotalCents"
  | "shippingCents"
  | "insurancePoolCents"
  | "feesCents"
  | "totalDebitCents"
  | "paymentHoldExpiresAt"
  | "paymentHoldReason"
  | "costEvidenceHash"
  | "pricingSnapshot"
>;

export interface PgDropshipOrderAcceptanceRepositoryDependencies {
  /**
   * Builds the `.ops` product-cost reader bound to the acceptance transaction's
   * client, so the cost is read in the same transaction that debits the wallet.
   * Defaults to the Shellz Club adapter's SAVEPOINT variant.
   */
  productCostReaderForTransaction?: (client: Pick<PoolClient, "query">) => DropshipProductCostReader;
}

export class PgDropshipOrderAcceptanceRepository implements DropshipOrderAcceptanceRepository {
  private readonly productCostReaderForTransaction: (client: Pick<PoolClient, "query">) => DropshipProductCostReader;

  constructor(
    private readonly dbPool: Pool = defaultPool,
    deps: PgDropshipOrderAcceptanceRepositoryDependencies = {},
  ) {
    this.productCostReaderForTransaction = deps.productCostReaderForTransaction
      ?? ((client) => PgShellzClubProductCostAdapter.forTransaction(client));
  }

  async acceptOrder(input: DropshipOrderAcceptanceInput): Promise<DropshipOrderAcceptanceResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await acceptOrderWithClient(client, input, this.productCostReaderForTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareCanonicalOrder(
    input: DropshipOrderAcceptanceInput,
  ): Promise<DropshipCanonicalOrderAcceptancePreparation> {
    return this.inTransaction((client) => prepareCanonicalOrderWithClient(
      client,
      input,
      this.productCostReaderForTransaction(client),
    ));
  }

  async markCanonicalInventoryClaimed(input: {
    acceptance: DropshipOrderAcceptanceInput;
    omsOrderId: number;
    wmsOrderId: number;
    inventoryClaimId: string | null;
  }): Promise<void> {
    await this.inTransaction((client) => markCanonicalInventoryClaimedWithClient(client, input));
  }

  async finalizeCanonicalOrder(
    input: DropshipOrderAcceptanceInput,
  ): Promise<DropshipOrderAcceptanceResult> {
    return this.inTransaction((client) => finalizeCanonicalOrderWithClient(client, input));
  }

  async markCanonicalInventoryClaimReleased(input: {
    acceptance: DropshipOrderAcceptanceInput;
    omsOrderId: number;
    wmsOrderId: number;
    inventoryClaimId: string | null;
    reason: string;
  }): Promise<void> {
    await this.inTransaction((client) => markCanonicalInventoryClaimReleasedWithClient(client, input));
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function acceptOrderWithClient(
  client: PoolClient,
  input: DropshipOrderAcceptanceInput,
  productCosts: DropshipProductCostReader,
): Promise<DropshipOrderAcceptanceResult> {
  const intake = await loadIntakeForUpdate(client, input);
  if (!intake) {
    throw new DropshipError(
      "DROPSHIP_ORDER_INTAKE_NOT_FOUND",
      "Dropship order intake was not found for acceptance.",
      {
        intakeId: input.intakeId,
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
      },
    );
  }

  if (intake.status === "accepted") {
    return replayAcceptedOrderWithClient(client, input, intake);
  }

  const { plan, vendor, wallet, inventoryLevels } = await planAcceptanceWithClient(
    client,
    input,
    intake,
    productCosts,
    "legacy_exact_sku",
  );

  if (plan.outcome === "payment_hold") {
    await markIntakePaymentHoldWithClient(client, {
      plan,
      input,
      wallet,
      shortfall: plan.funding.outcome === "payment_hold" ? plan.funding.shortfall : null,
      rewardsCents: plan.funding.rewardsCents,
    });
    return paymentHoldResult(plan, plan.funding.rewardsCents);
  }

  const omsOrderId = await createOmsOrderWithClient(client, plan, intake);
  const omsLines = await createOmsOrderLinesWithClient(client, {
    omsOrderId,
    plan,
  });
  // P0.1a — SINGLE-WRITER RESERVATION: acceptance no longer writes
  // reserved_qty. The old raw-SQL reserve here double-reserved every order
  // (WMS sync reserves again with WMS ids and cannot see these rows) and had
  // no release path — reserved stock leaked permanently on cancel. Acceptance
  // now only VALIDATES availability; the one reservation happens at WMS sync
  // (dispatched right after acceptance). P3.2 upgrades acceptance to await
  // that reservation synchronously before confirming to the partner.
  validateInventoryAvailability({
    plan,
    inventoryLevels,
    omsOrderId,
  });
  const debit = await debitWalletWithClient(client, {
    plan,
    wallet,
    input,
    funding: plan.funding,
  });
  const walletLedgerEntryId = debit.ledgerEntryId;
  const economicsSnapshotId = await createEconomicsSnapshotWithClient(client, {
    plan,
    vendor,
    omsOrderId,
  });
  await markIntakeAcceptedWithClient(client, {
    intakeId: plan.intakeId,
    omsOrderId,
    acceptedAt: input.acceptedAt,
  });
  await recordAcceptanceAuditEventWithClient(client, {
    plan,
    input,
    eventType: "order_accepted",
    severity: "info",
    payload: {
      omsOrderId,
      walletLedgerEntryId,
      economicsSnapshotId,
      totalDebitCents: plan.totalDebitCents,
      advance: debit.advance,
      requestHash: input.requestHash,
    },
  });

  return {
    outcome: "accepted",
    intakeId: plan.intakeId,
    vendorId: plan.vendorId,
    storeConnectionId: plan.storeConnectionId,
    shippingQuoteSnapshotId: plan.shippingQuoteSnapshotId,
    omsOrderId,
    walletLedgerEntryId,
    economicsSnapshotId,
    totalDebitCents: plan.totalDebitCents,
    rewardsCents: debit.rewardsCents,
    currency: plan.currency,
    paymentHoldExpiresAt: null,
    paymentHoldReason: null,
    advance: debit.advance,
    idempotentReplay: false,
  };
}

async function prepareCanonicalOrderWithClient(
  client: PoolClient,
  input: DropshipOrderAcceptanceInput,
  productCosts: DropshipProductCostReader,
): Promise<DropshipCanonicalOrderAcceptancePreparation> {
  const intake = await loadIntakeForUpdate(client, input);
  if (!intake) {
    throw acceptanceIntakeNotFound(input);
  }
  if (intake.status === "accepted") {
    return replayAcceptedOrderWithClient(client, input, intake);
  }

  const existingStage = await loadCanonicalAcceptanceStageForUpdate(client, input.intakeId);
  if (existingStage) {
    assertCanonicalStageIntakeCanResume(intake, input.acceptedAt, existingStage.state);
    assertCanonicalStageMatches(existingStage, input, intake);
    if (existingStage.state === "finalized") {
      throw new DropshipError(
        "DROPSHIP_CANONICAL_ACCEPTANCE_STATE_INVALID",
        "Canonical acceptance stage is finalized but its intake is not accepted.",
        { intakeId: input.intakeId, omsOrderId: Number(existingStage.oms_order_id) },
      );
    }
    if (existingStage.state === "expired") {
      throw canonicalPaymentHoldExpired(intake);
    }
    if (existingStage.state === "compensation_pending") {
      const claimAttempt = await requireCanonicalClaimAttemptWithClient(
        client,
        existingStage,
        ["compensation_pending"],
      );
      return canonicalCompensationFromStage(existingStage, claimAttempt, intake, input.acceptedAt);
    }
    if (existingStage.state === "inventory_released") {
      const releasedAttempt = await requireCanonicalClaimAttemptWithClient(
        client,
        existingStage,
        ["released"],
      );
      if (intake.paymentHoldExpiresAt == null) {
        throw canonicalPaymentHoldExpired(intake);
      }
      if (intake.paymentHoldExpiresAt <= input.acceptedAt) {
        return canonicalCompensationFromStage(existingStage, releasedAttempt, intake, input.acceptedAt);
      }
      const wallet = await getOrCreateWalletForUpdate(client, {
        vendorId: existingStage.vendor_id,
        currency: existingStage.currency,
        now: input.acceptedAt,
      });
      if (wallet.walletAccountId !== existingStage.wallet_account_id) {
        throw canonicalStageConflict(input.intakeId, {
          stagedWalletAccountId: existingStage.wallet_account_id,
          currentWalletAccountId: wallet.walletAccountId,
        });
      }
      const plan = financialPlanFromCanonicalStage(existingStage, input.acceptedAt);
      const vendor = await loadVendorContextForUpdate(client, {
        vendorId: existingStage.vendor_id,
        storeConnectionId: existingStage.store_connection_id,
      });
      // A vendor still paused for funding does not get their inventory
      // re-claimed only to be held again at finalization.
      const heldForStanding = vendor !== null && vendorOrderAdmissionFor({
        status: vendor.vendorStatus,
        standingReason: vendor.vendorStandingReason,
      }) === "hold";
      const funding = decideAcceptanceFunding({
        availableBalanceCents: wallet.availableBalanceCents,
        totalDebitCents: plan.totalDebitCents,
        standingHold: heldForStanding,
        advance: wallet.advance,
        rewards: { balanceCents: wallet.rewardsBalanceCents, spendFirst: wallet.spendRewardsFirst },
      });
      if (funding.outcome === "payment_hold") {
        return {
          ...paymentHoldResult({
            ...plan,
            outcome: "payment_hold",
            paymentHoldExpiresAt: intake.paymentHoldExpiresAt,
            paymentHoldReason: funding.reason,
          }, funding.rewardsCents),
          idempotentReplay: true,
        };
      }
      const reopenedStage = await reopenCanonicalStageForClaimWithClient(
        client,
        existingStage,
        input,
      );
      await markIntakeCanonicalAcceptanceProcessingWithClient(client, {
        intakeId: input.intakeId,
        omsOrderId: Number(existingStage.oms_order_id),
        updatedAt: input.acceptedAt,
      });
      return canonicalPreparationFromStage(reopenedStage, true);
    }
    const paymentHoldExpired = intake.paymentHoldExpiresAt != null
      && intake.paymentHoldExpiresAt <= input.acceptedAt;
    if (existingStage.state === "inventory_claimed"
      && (intake.status === "payment_hold" || paymentHoldExpired)) {
      const compensation = await markCanonicalCompensationPendingWithClient(
        client,
        existingStage,
        input.acceptedAt,
        paymentHoldExpired
          ? "payment_hold_expired_before_finalization"
          : "wallet_balance_changed_before_finalization",
      );
      return canonicalCompensationFromStage(
        compensation.stage,
        compensation.claimAttempt,
        intake,
        input.acceptedAt,
      );
    }
    await markIntakeCanonicalAcceptanceProcessingWithClient(client, {
      intakeId: input.intakeId,
      omsOrderId: Number(existingStage.oms_order_id),
      updatedAt: input.acceptedAt,
    });
    return canonicalPreparationFromStage(existingStage, true);
  }

  const { plan, vendor, wallet } = await planAcceptanceWithClient(
    client,
    input,
    intake,
    productCosts,
    "canonical_claim",
  );
  if (plan.outcome === "payment_hold") {
    await markIntakePaymentHoldWithClient(client, {
      plan,
      input,
      wallet,
      shortfall: plan.funding.outcome === "payment_hold" ? plan.funding.shortfall : null,
      rewardsCents: plan.funding.rewardsCents,
    });
    return paymentHoldResult(plan, plan.funding.rewardsCents);
  }

  const omsOrderId = await createOmsOrderWithClient(client, plan, intake, {
    stagedForCanonicalAcceptance: true,
  });
  await createOmsOrderLinesWithClient(client, { omsOrderId, plan });
  await insertCanonicalAcceptanceStageWithClient(client, {
    plan,
    vendor,
    wallet,
    input,
    omsOrderId,
  });
  await markIntakeCanonicalAcceptanceProcessingWithClient(client, {
    intakeId: plan.intakeId,
    omsOrderId,
    updatedAt: input.acceptedAt,
  });
  await recordAcceptanceAuditEventWithClient(client, {
    plan,
    input,
    eventType: "order_acceptance_prepared",
    severity: "info",
    payload: {
      omsOrderId,
      inventoryAuthority: "canonical",
      requestHash: input.requestHash,
    },
  });
  return {
    outcome: "prepared",
    intakeId: plan.intakeId,
    vendorId: plan.vendorId,
    storeConnectionId: plan.storeConnectionId,
    shippingQuoteSnapshotId: plan.shippingQuoteSnapshotId,
    warehouseId: plan.warehouseId,
    omsOrderId,
    idempotentReplay: false,
  };
}

async function markCanonicalInventoryClaimedWithClient(
  client: PoolClient,
  input: {
    acceptance: DropshipOrderAcceptanceInput;
    omsOrderId: number;
    wmsOrderId: number;
    inventoryClaimId: string | null;
  },
): Promise<void> {
  const intake = await loadIntakeForUpdate(client, input.acceptance);
  if (!intake) throw acceptanceIntakeNotFound(input.acceptance);
  const stage = await requireCanonicalAcceptanceStageForUpdate(
    client,
    input.acceptance,
    input.omsOrderId,
  );
  if (stage.state === "finalized") return;
  if (stage.state === "inventory_claimed") {
    if (Number(stage.wms_order_id) !== input.wmsOrderId) {
      throw canonicalStageConflict(input.acceptance.intakeId, {
        stagedWmsOrderId: stage.wms_order_id,
        claimedWmsOrderId: input.wmsOrderId,
      });
    }
    await assertCanonicalClaimWarehouseWithClient(client, {
      stage,
      omsOrderId: input.omsOrderId,
      wmsOrderId: input.wmsOrderId,
    });
    const claimAttempt = await requireCanonicalClaimAttemptWithClient(client, stage, ["claimed"]);
    assertCanonicalClaimIdMatchesInput(stage.intake_id, claimAttempt, input.inventoryClaimId);
    await assertCanonicalAvailabilityClaimWithClient(
      client,
      stage,
      input.wmsOrderId,
      input.inventoryClaimId,
    );
    return;
  }
  if (stage.state !== "prepared") {
    throw canonicalStageConflict(input.acceptance.intakeId, {
      stageState: stage.state,
      expectedState: "prepared",
    });
  }
  await assertCanonicalClaimWarehouseWithClient(client, {
    stage,
    omsOrderId: input.omsOrderId,
    wmsOrderId: input.wmsOrderId,
  });
  await assertCanonicalAvailabilityClaimWithClient(
    client,
    stage,
    input.wmsOrderId,
    input.inventoryClaimId,
  );
  const claimAttemptNumber = await insertCanonicalClaimAttemptWithClient(client, {
    stage,
    wmsOrderId: input.wmsOrderId,
    inventoryClaimId: input.inventoryClaimId,
    claimedAt: input.acceptance.acceptedAt,
  });
  await client.query(
    `UPDATE dropship.dropship_order_acceptance_stages
     SET state = 'inventory_claimed',
         wms_order_id = $2,
         inventory_claimed_at = $3,
         claim_attempt_number = $4,
         updated_at = $3
     WHERE intake_id = $1`,
    [input.acceptance.intakeId, input.wmsOrderId, input.acceptance.acceptedAt, claimAttemptNumber],
  );
  await recordCanonicalStageAuditEventWithClient(client, stage, input.acceptance, {
    eventType: "order_acceptance_inventory_claimed",
    payload: {
      omsOrderId: input.omsOrderId,
      wmsOrderId: input.wmsOrderId,
      claimAttemptNumber,
    },
  });
}

async function finalizeCanonicalOrderWithClient(
  client: PoolClient,
  input: DropshipOrderAcceptanceInput,
): Promise<DropshipOrderAcceptanceResult> {
  const intake = await loadIntakeForUpdate(client, input);
  if (!intake) throw acceptanceIntakeNotFound(input);
  if (intake.status === "accepted") {
    return replayAcceptedOrderWithClient(client, input, intake);
  }

  const stage = await requireCanonicalAcceptanceStageForUpdate(client, input, intake.omsOrderId);
  if (stage.state !== "inventory_claimed" || stage.wms_order_id == null) {
    throw new DropshipError(
      "DROPSHIP_CANONICAL_INVENTORY_CLAIM_REQUIRED",
      "Canonical dropship acceptance cannot finalize before its whole-order inventory claim succeeds.",
      { intakeId: input.intakeId, stageState: stage.state },
    );
  }
  const claimAttempt = await requireCanonicalClaimAttemptWithClient(client, stage, ["claimed"]);
  const inventoryClaimId = normalizeNullableClaimId(claimAttempt.availability_claim_id);
  await assertCanonicalAvailabilityClaimWithClient(
    client,
    stage,
    toSafeInteger(stage.wms_order_id, "stage.wms_order_id"),
    inventoryClaimId,
  );

  const vendor = await loadVendorContextForUpdate(client, {
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
  });
  if (!vendor) {
    throw new DropshipError(
      "DROPSHIP_ORDER_VENDOR_CONTEXT_REQUIRED",
      "Dropship vendor/store context was not found for order acceptance finalization.",
      { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId },
    );
  }
  assertVendorContextCanFinalize(vendor);

  const wallet = await getOrCreateWalletForUpdate(client, {
    vendorId: input.vendorId,
    currency: stage.currency,
    now: input.acceptedAt,
  });
  if (wallet.walletAccountId !== stage.wallet_account_id) {
    throw canonicalStageConflict(input.intakeId, {
      stagedWalletAccountId: stage.wallet_account_id,
      currentWalletAccountId: wallet.walletAccountId,
    });
  }

  const plan = financialPlanFromCanonicalStage(stage, input.acceptedAt);
  const stagedInput = frozenAcceptanceInput(stage, input.acceptedAt);
  const paymentHoldExpired = intake.paymentHoldExpiresAt != null
    && intake.paymentHoldExpiresAt <= input.acceptedAt;
  // The vendor may have been paused for funding between staging and now.
  const heldForStanding = vendorOrderAdmissionFor({
    status: vendor.vendorStatus,
    standingReason: vendor.vendorStandingReason,
  }) === "hold";
  // The funding decision is made again here, from the wallet as it is now:
  // a pending credit may have settled or failed since the order was staged.
  const funding = decideAcceptanceFunding({
    availableBalanceCents: wallet.availableBalanceCents,
    totalDebitCents: plan.totalDebitCents,
    standingHold: heldForStanding,
    advance: wallet.advance,
    rewards: { balanceCents: wallet.rewardsBalanceCents, spendFirst: wallet.spendRewardsFirst },
  });
  if (paymentHoldExpired || funding.outcome === "payment_hold") {
    const timeoutMinutes = await loadPaymentHoldTimeoutWithClient(client, input.vendorId);
    const paymentHoldPlan: AcceptanceFinancialPlan = {
      ...plan,
      outcome: "payment_hold",
      paymentHoldExpiresAt: intake.paymentHoldExpiresAt
        ?? new Date(input.acceptedAt.getTime() + normalizePositiveMinutes(timeoutMinutes) * 60_000),
      paymentHoldReason: heldForStanding ? "vendor_paused" : "insufficient_balance",
    };
    await markIntakePaymentHoldWithClient(client, {
      plan: paymentHoldPlan,
      input: stagedInput,
      wallet,
      shortfall: funding.outcome === "payment_hold" ? funding.shortfall : null,
      rewardsCents: funding.rewardsCents,
    });
    await markCanonicalCompensationPendingWithClient(
      client,
      stage,
      input.acceptedAt,
      paymentHoldExpired
        ? "payment_hold_expired_before_finalization"
        : heldForStanding
          ? "vendor_paused_before_finalization"
          : "wallet_balance_changed_before_finalization",
    );
    await recordCanonicalStageAuditEventWithClient(client, stage, stagedInput, {
      eventType: paymentHoldExpired
        ? "order_acceptance_payment_hold_expired_after_inventory_claim"
        : heldForStanding
          ? "order_acceptance_vendor_paused_after_inventory_claim"
          : "order_acceptance_wallet_changed_after_inventory_claim",
      severity: "warning",
      payload: {
        wmsOrderId: Number(stage.wms_order_id),
        availableBalanceCents: wallet.availableBalanceCents,
        requiredCents: plan.totalDebitCents,
        vendorStatus: vendor.vendorStatus,
        vendorStandingReason: vendor.vendorStandingReason,
      },
    });
    return paymentHoldResult(paymentHoldPlan, funding.rewardsCents);
  }

  const debit = await debitWalletWithClient(client, { plan, wallet, input: stagedInput, funding });
  const walletLedgerEntryId = debit.ledgerEntryId;
  const economicsSnapshotId = await createEconomicsSnapshotWithClient(client, {
    plan,
    vendor: {
      memberId: stage.member_id,
      membershipPlanId: stage.membership_plan_id,
      currentPlanId: stage.membership_plan_id,
    },
    omsOrderId: Number(stage.oms_order_id),
  });
  await markOmsOrderAcceptedWithClient(client, Number(stage.oms_order_id), input.acceptedAt);
  await markIntakeAcceptedWithClient(client, {
    intakeId: plan.intakeId,
    omsOrderId: Number(stage.oms_order_id),
    acceptedAt: input.acceptedAt,
  });
  await client.query(
    `UPDATE dropship.dropship_order_acceptance_claim_attempts
     SET state = 'finalized', finalized_at = $3, updated_at = $3
     WHERE intake_id = $1 AND attempt_number = $2`,
    [stage.intake_id, claimAttempt.attempt_number, input.acceptedAt],
  );
  await client.query(
    `UPDATE dropship.dropship_order_acceptance_stages
     SET state = 'finalized', finalized_at = $2, updated_at = $2
     WHERE intake_id = $1`,
    [input.intakeId, input.acceptedAt],
  );
  await recordAcceptanceAuditEventWithClient(client, {
    plan,
    input: stagedInput,
    eventType: "order_accepted",
    severity: "info",
    payload: {
      omsOrderId: Number(stage.oms_order_id),
      wmsOrderId: Number(stage.wms_order_id),
      walletLedgerEntryId,
      economicsSnapshotId,
      totalDebitCents: plan.totalDebitCents,
      advance: debit.advance,
      requestHash: input.requestHash,
      inventoryAuthority: "canonical",
    },
  });
  return {
    outcome: "accepted",
    intakeId: plan.intakeId,
    vendorId: plan.vendorId,
    storeConnectionId: plan.storeConnectionId,
    shippingQuoteSnapshotId: plan.shippingQuoteSnapshotId,
    omsOrderId: Number(stage.oms_order_id),
    walletLedgerEntryId,
    economicsSnapshotId,
    totalDebitCents: plan.totalDebitCents,
    rewardsCents: debit.rewardsCents,
    currency: plan.currency,
    paymentHoldExpiresAt: null,
    paymentHoldReason: null,
    advance: debit.advance,
    idempotentReplay: false,
  };
}

async function markCanonicalInventoryClaimReleasedWithClient(
  client: PoolClient,
  input: {
    acceptance: DropshipOrderAcceptanceInput;
    omsOrderId: number;
    wmsOrderId: number;
    inventoryClaimId: string | null;
    reason: string;
  },
): Promise<void> {
  const intake = await loadIntakeForUpdate(client, input.acceptance);
  if (!intake) throw acceptanceIntakeNotFound(input.acceptance);
  const stage = await requireCanonicalAcceptanceStageForUpdate(client, input.acceptance, input.omsOrderId);
  if (stage.state === "finalized") {
    throw new DropshipError(
      "DROPSHIP_CANONICAL_ACCEPTANCE_ALREADY_FINALIZED",
      "A finalized dropship acceptance claim cannot be released by pre-acceptance compensation.",
      { intakeId: input.acceptance.intakeId, omsOrderId: input.omsOrderId },
    );
  }
  if (stage.state === "inventory_released" || stage.state === "expired") {
    if (Number(stage.wms_order_id) !== input.wmsOrderId) {
      throw canonicalStageConflict(input.acceptance.intakeId, {
        stagedWmsOrderId: stage.wms_order_id,
        releasedWmsOrderId: input.wmsOrderId,
      });
    }
    const claimAttempt = await requireCanonicalClaimAttemptWithClient(
      client,
      stage,
      [stage.state === "expired" ? "expired" : "released"],
    );
    assertCanonicalClaimIdMatchesInput(stage.intake_id, claimAttempt, input.inventoryClaimId);
    if (stage.state === "expired"
      || intake.paymentHoldExpiresAt == null
      || intake.paymentHoldExpiresAt > input.acceptance.acceptedAt) {
      return;
    }
    await client.query(
      `UPDATE dropship.dropship_order_acceptance_claim_attempts
       SET state = 'expired', expired_at = $3, updated_at = $3
       WHERE intake_id = $1 AND attempt_number = $2`,
      [stage.intake_id, claimAttempt.attempt_number, input.acceptance.acceptedAt],
    );
    await client.query(
      `UPDATE dropship.dropship_order_acceptance_stages
       SET state = 'expired', expired_at = $2, updated_at = $2
       WHERE intake_id = $1`,
      [input.acceptance.intakeId, input.acceptance.acceptedAt],
    );
    await recordCanonicalStageAuditEventWithClient(client, stage, input.acceptance, {
      eventType: "order_acceptance_payment_hold_expired_after_inventory_release",
      severity: "warning",
      payload: {
        omsOrderId: input.omsOrderId,
        wmsOrderId: input.wmsOrderId,
        paymentHoldExpiresAt: intake.paymentHoldExpiresAt.toISOString(),
      },
    });
    return;
  }
  if (stage.state !== "compensation_pending") {
    throw canonicalStageConflict(input.acceptance.intakeId, {
      stageState: stage.state,
      expectedState: "compensation_pending",
    });
  }
  if (Number(stage.wms_order_id) !== input.wmsOrderId) {
    throw canonicalStageConflict(input.acceptance.intakeId, {
      stagedWmsOrderId: stage.wms_order_id,
      releasedWmsOrderId: input.wmsOrderId,
    });
  }
  const claimAttempt = await requireCanonicalClaimAttemptWithClient(
    client,
    stage,
    ["compensation_pending"],
  );
  assertCanonicalClaimIdMatchesInput(stage.intake_id, claimAttempt, input.inventoryClaimId);
  const expired = intake.paymentHoldExpiresAt == null
    ? false
    : intake.paymentHoldExpiresAt <= input.acceptance.acceptedAt;
  await client.query(
    `UPDATE dropship.dropship_order_acceptance_claim_attempts
     SET state = $3,
         released_at = $4,
         expired_at = CASE WHEN $3 = 'expired' THEN $4 ELSE NULL END,
         updated_at = $4
     WHERE intake_id = $1 AND attempt_number = $2`,
    [
      stage.intake_id,
      claimAttempt.attempt_number,
      expired ? "expired" : "released",
      input.acceptance.acceptedAt,
    ],
  );
  await client.query(
    `UPDATE dropship.dropship_order_acceptance_stages
     SET state = $2,
         inventory_released_at = $3,
         expired_at = CASE WHEN $2 = 'expired' THEN $3 ELSE NULL END,
         updated_at = $3
     WHERE intake_id = $1`,
    [input.acceptance.intakeId, expired ? "expired" : "inventory_released", input.acceptance.acceptedAt],
  );
  await recordCanonicalStageAuditEventWithClient(client, stage, input.acceptance, {
    eventType: "order_acceptance_inventory_claim_released",
    severity: "warning",
    payload: {
      omsOrderId: input.omsOrderId,
      wmsOrderId: input.wmsOrderId,
      claimAttemptNumber: claimAttempt.attempt_number,
      reason: stage.inventory_release_reason,
    },
  });
}

async function markCanonicalCompensationPendingWithClient(
  client: PoolClient,
  stage: CanonicalAcceptanceStageRow,
  requestedAt: Date,
  reason: string,
): Promise<{ stage: CanonicalAcceptanceStageRow; claimAttempt: CanonicalClaimAttemptRow }> {
  if (stage.state === "compensation_pending") {
    const claimAttempt = await requireCanonicalClaimAttemptWithClient(
      client,
      stage,
      ["compensation_pending"],
    );
    return { stage, claimAttempt };
  }
  if (stage.state !== "inventory_claimed" || stage.wms_order_id == null) {
    throw canonicalStageConflict(stage.intake_id, {
      stageState: stage.state,
      expectedState: "inventory_claimed",
    });
  }
  const normalizedReason = reason.trim();
  if (normalizedReason.length === 0) {
    throw new DropshipError(
      "DROPSHIP_CANONICAL_COMPENSATION_REASON_REQUIRED",
      "Canonical inventory-claim compensation requires a durable reason.",
      { intakeId: stage.intake_id },
    );
  }
  const claimAttempt = await requireCanonicalClaimAttemptWithClient(client, stage, ["claimed"]);
  await client.query(
    `UPDATE dropship.dropship_order_acceptance_claim_attempts
     SET state = 'compensation_pending',
         release_requested_at = $3,
         release_reason = $4,
         updated_at = $3
     WHERE intake_id = $1 AND attempt_number = $2`,
    [stage.intake_id, claimAttempt.attempt_number, requestedAt, normalizedReason],
  );
  await client.query(
    `UPDATE dropship.dropship_order_acceptance_stages
     SET state = 'compensation_pending',
         inventory_release_requested_at = $2,
         inventory_release_reason = $3,
         updated_at = $2
     WHERE intake_id = $1`,
    [stage.intake_id, requestedAt, normalizedReason],
  );
  const transitioned: CanonicalAcceptanceStageRow = {
    ...stage,
    state: "compensation_pending",
    inventory_release_requested_at: requestedAt,
    inventory_release_reason: normalizedReason,
  };
  await recordCanonicalStageAuditEventWithClient(
    client,
    transitioned,
    frozenAcceptanceInput(stage, requestedAt),
    {
      eventType: "order_acceptance_inventory_claim_release_requested",
      severity: "warning",
      payload: {
        omsOrderId: Number(stage.oms_order_id),
        wmsOrderId: Number(stage.wms_order_id),
        claimAttemptNumber: claimAttempt.attempt_number,
        reason: normalizedReason,
      },
    },
  );
  return {
    stage: transitioned,
    claimAttempt: {
      ...claimAttempt,
      state: "compensation_pending",
      release_requested_at: requestedAt,
      release_reason: normalizedReason,
    },
  };
}

async function assertCanonicalClaimWarehouseWithClient(
  client: PoolClient,
  input: {
    stage: CanonicalAcceptanceStageRow;
    omsOrderId: number;
    wmsOrderId: number;
  },
): Promise<void> {
  const result = await client.query<{
    id: string | number;
    warehouse_id: string | number | null;
    source: string | null;
    oms_fulfillment_order_id: string | null;
    fulfillment_partition_key: string | null;
  }>(
    `SELECT id, warehouse_id, source, oms_fulfillment_order_id, fulfillment_partition_key
     FROM wms.orders
     WHERE id = $1
     LIMIT 1
     FOR SHARE`,
    [input.wmsOrderId],
  );
  const row = result.rows[0];
  const actualWarehouseId = row?.warehouse_id == null ? null : Number(row.warehouse_id);
  if (
    result.rows.length !== 1
    || actualWarehouseId !== input.stage.warehouse_id
    || row?.source !== "oms"
    || String(row?.oms_fulfillment_order_id ?? "") !== String(input.omsOrderId)
    || String(row?.fulfillment_partition_key ?? "default") !== "default"
  ) {
    throw new DropshipError(
      "DROPSHIP_CANONICAL_WAREHOUSE_MISMATCH",
      "Canonical dropship acceptance claim does not match the frozen quote warehouse and OMS order.",
      {
        intakeId: input.stage.intake_id,
        omsOrderId: input.omsOrderId,
        wmsOrderId: input.wmsOrderId,
        expectedWarehouseId: input.stage.warehouse_id,
        actualWarehouseId,
        wmsSource: row?.source ?? null,
        wmsOmsOrderId: row?.oms_fulfillment_order_id ?? null,
        fulfillmentPartitionKey: row?.fulfillment_partition_key ?? null,
      },
    );
  }
}

async function assertCanonicalAvailabilityClaimWithClient(
  client: PoolClient,
  stage: CanonicalAcceptanceStageRow,
  wmsOrderId: number,
  inventoryClaimId: string | null,
): Promise<void> {
  const result = inventoryClaimId === null
    ? await client.query<{ id: string | number; order_id: number; status: string }>(
      `SELECT id, order_id, status
       FROM inventory.availability_claims
       WHERE order_id = $1 AND status = 'active'
       ORDER BY revision DESC, id DESC
       LIMIT 1
       FOR SHARE`,
      [wmsOrderId],
    )
    : await client.query<{ id: string | number; order_id: number; status: string }>(
      `SELECT id, order_id, status
       FROM inventory.availability_claims
       WHERE id = $1
       LIMIT 1
       FOR SHARE`,
      [inventoryClaimId],
    );
  const row = result.rows[0];
  const valid = inventoryClaimId === null
    ? row == null
    : row != null
      && String(row.id) === inventoryClaimId
      && Number(row.order_id) === wmsOrderId
      && row.status === "active";
  if (!valid) {
    throw new DropshipError(
      "DROPSHIP_CANONICAL_CLAIM_ID_MISMATCH",
      "Canonical dropship acceptance inventory claim no longer matches its exact WMS claim attempt.",
      {
        intakeId: stage.intake_id,
        wmsOrderId,
        expectedInventoryClaimId: inventoryClaimId,
        actualInventoryClaimId: row == null ? null : String(row.id),
        actualInventoryClaimOrderId: row?.order_id ?? null,
        actualInventoryClaimStatus: row?.status ?? null,
      },
    );
  }
}

async function insertCanonicalClaimAttemptWithClient(
  client: PoolClient,
  input: {
    stage: CanonicalAcceptanceStageRow;
    wmsOrderId: number;
    inventoryClaimId: string | null;
    claimedAt: Date;
  },
): Promise<number> {
  const nextResult = await client.query<{ attempt_number: string | number }>(
    `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
     FROM dropship.dropship_order_acceptance_claim_attempts
     WHERE intake_id = $1`,
    [input.stage.intake_id],
  );
  const attemptNumber = toSafeInteger(
    requiredRow(nextResult.rows[0], "Canonical claim attempt sequence did not return a row.").attempt_number,
    "claim_attempt_number",
  );
  if (attemptNumber <= 0) {
    throw canonicalStageConflict(input.stage.intake_id, { claimAttemptNumber: attemptNumber });
  }
  await client.query(
    `INSERT INTO dropship.dropship_order_acceptance_claim_attempts
      (intake_id, attempt_number, oms_order_id, wms_order_id, warehouse_id,
       claim_authority, claim_owner, claim_outcome, availability_claim_id,
       state, claimed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5,
             'canonical', 'dropship_acceptance', $6, $7,
             'claimed', $8, $8)`,
    [
      input.stage.intake_id,
      attemptNumber,
      Number(input.stage.oms_order_id),
      input.wmsOrderId,
      input.stage.warehouse_id,
      input.inventoryClaimId === null ? "no_claim_required" : "claimed",
      input.inventoryClaimId,
      input.claimedAt,
    ],
  );
  return attemptNumber;
}

async function requireCanonicalClaimAttemptWithClient(
  client: PoolClient,
  stage: CanonicalAcceptanceStageRow,
  expectedStates: readonly CanonicalClaimAttemptRow["state"][],
): Promise<CanonicalClaimAttemptRow> {
  if (stage.claim_attempt_number == null || stage.wms_order_id == null) {
    throw canonicalStageConflict(stage.intake_id, {
      stageState: stage.state,
      claimAttemptNumber: stage.claim_attempt_number,
      wmsOrderId: stage.wms_order_id,
    });
  }
  const result = await client.query<CanonicalClaimAttemptRow>(
    `SELECT intake_id, attempt_number, oms_order_id, wms_order_id, warehouse_id,
            claim_authority, claim_owner, claim_outcome, availability_claim_id,
            state, claimed_at,
            release_requested_at, released_at, release_reason, expired_at, finalized_at
     FROM dropship.dropship_order_acceptance_claim_attempts
     WHERE intake_id = $1 AND attempt_number = $2
     LIMIT 1
     FOR UPDATE`,
    [stage.intake_id, stage.claim_attempt_number],
  );
  const attempt = result.rows[0];
  if (!attempt) {
    throw canonicalStageConflict(stage.intake_id, {
      claimAttemptNumber: stage.claim_attempt_number,
      claimAttempt: "missing",
    });
  }
  const mismatches: Record<string, unknown> = {};
  if (Number(attempt.oms_order_id) !== Number(stage.oms_order_id)) {
    mismatches.omsOrderId = { stage: stage.oms_order_id, attempt: attempt.oms_order_id };
  }
  if (Number(attempt.wms_order_id) !== Number(stage.wms_order_id)) {
    mismatches.wmsOrderId = { stage: stage.wms_order_id, attempt: attempt.wms_order_id };
  }
  if (attempt.warehouse_id !== stage.warehouse_id) {
    mismatches.warehouseId = { stage: stage.warehouse_id, attempt: attempt.warehouse_id };
  }
  if (attempt.claim_authority !== "canonical" || attempt.claim_owner !== "dropship_acceptance") {
    mismatches.claimIdentity = {
      authority: attempt.claim_authority,
      owner: attempt.claim_owner,
    };
  }
  const availabilityClaimId = normalizeNullableClaimId(attempt.availability_claim_id);
  if ((attempt.claim_outcome === "claimed" && availabilityClaimId === null)
    || (attempt.claim_outcome === "no_claim_required" && availabilityClaimId !== null)) {
    mismatches.availabilityClaim = {
      outcome: attempt.claim_outcome,
      claimId: availabilityClaimId,
    };
  }
  if (!expectedStates.includes(attempt.state)) {
    mismatches.claimState = { expected: expectedStates, actual: attempt.state };
  }
  assertCanonicalClaimAttemptTimestamps(stage, attempt, mismatches);
  if (Object.keys(mismatches).length > 0) {
    throw canonicalStageConflict(stage.intake_id, mismatches);
  }
  return attempt;
}

function assertCanonicalClaimIdMatchesInput(
  intakeId: number,
  attempt: CanonicalClaimAttemptRow,
  inventoryClaimId: string | null,
): void {
  const persistedClaimId = normalizeNullableClaimId(attempt.availability_claim_id);
  if (persistedClaimId !== inventoryClaimId) {
    throw canonicalStageConflict(intakeId, {
      inventoryClaimId: { persisted: persistedClaimId, requested: inventoryClaimId },
    });
  }
}

function normalizeNullableClaimId(value: string | number | null): string | null {
  if (value === null) return null;
  const normalized = String(value);
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new DropshipError(
      "DROPSHIP_CANONICAL_CLAIM_ID_INVALID",
      "Canonical dropship claim evidence contains an invalid inventory claim identity.",
      { inventoryClaimId: normalized },
    );
  }
  return normalized;
}

function assertCanonicalClaimAttemptTimestamps(
  stage: CanonicalAcceptanceStageRow,
  attempt: CanonicalClaimAttemptRow,
  mismatches: Record<string, unknown>,
): void {
  const comparisons: ReadonlyArray<[
    string,
    Date | null,
    Date | null,
  ]> = [
    ["claimedAt", stage.inventory_claimed_at, attempt.claimed_at],
    ["releaseRequestedAt", stage.inventory_release_requested_at, attempt.release_requested_at],
    ["releasedAt", stage.inventory_released_at, attempt.released_at],
    ["expiredAt", stage.expired_at, attempt.expired_at],
    ["finalizedAt", stage.finalized_at, attempt.finalized_at],
  ];
  for (const [field, staged, attempted] of comparisons) {
    if (!sameInstant(staged, attempted)) {
      mismatches[field] = {
        stage: staged?.toISOString() ?? null,
        attempt: attempted?.toISOString() ?? null,
      };
    }
  }
  if (stage.inventory_release_reason !== attempt.release_reason) {
    mismatches.releaseReason = {
      stage: stage.inventory_release_reason,
      attempt: attempt.release_reason,
    };
  }
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

async function reopenCanonicalStageForClaimWithClient(
  client: PoolClient,
  stage: CanonicalAcceptanceStageRow,
  input: DropshipOrderAcceptanceInput,
): Promise<CanonicalAcceptanceStageRow> {
  if (stage.state !== "inventory_released") {
    throw canonicalStageConflict(stage.intake_id, {
      stageState: stage.state,
      expectedState: "inventory_released",
    });
  }
  const releasedAttempt = await requireCanonicalClaimAttemptWithClient(client, stage, ["released"]);
  await client.query(
    `UPDATE dropship.dropship_order_acceptance_stages
     SET state = 'prepared',
         claim_attempt_number = NULL,
         wms_order_id = NULL,
         inventory_claimed_at = NULL,
         inventory_release_requested_at = NULL,
         inventory_released_at = NULL,
         inventory_release_reason = NULL,
         expired_at = NULL,
         finalized_at = NULL,
         updated_at = $2
     WHERE intake_id = $1`,
    [stage.intake_id, input.acceptedAt],
  );
  await recordCanonicalStageAuditEventWithClient(client, stage, input, {
    eventType: "order_acceptance_reopened_after_inventory_release",
    severity: "info",
    payload: {
      omsOrderId: Number(stage.oms_order_id),
      releasedWmsOrderId: Number(stage.wms_order_id),
      releasedClaimAttemptNumber: releasedAttempt.attempt_number,
    },
  });
  return {
    ...stage,
    state: "prepared",
    claim_attempt_number: null,
    wms_order_id: null,
    inventory_claimed_at: null,
    inventory_release_requested_at: null,
    inventory_released_at: null,
    inventory_release_reason: null,
    expired_at: null,
    finalized_at: null,
  };
}

async function planAcceptanceWithClient(
  client: PoolClient,
  input: DropshipOrderAcceptanceInput,
  intake: DropshipAcceptanceIntakeRecord,
  productCosts: DropshipProductCostReader,
  inventoryValidation: "legacy_exact_sku" | "canonical_claim",
): Promise<{
  plan: DropshipOrderAcceptancePlan;
  vendor: DropshipAcceptanceVendorContext;
  wallet: DropshipAcceptanceWalletState;
  inventoryLevels: InventoryLevelRow[];
}> {
  const vendor = await loadVendorContextForUpdate(client, {
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
  });
  if (!vendor) {
    throw new DropshipError(
      "DROPSHIP_ORDER_VENDOR_CONTEXT_REQUIRED",
      "Dropship vendor/store context was not found for order acceptance.",
      { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId },
    );
  }
  const quote = await loadQuoteSnapshotWithClient(client, input);
  // The quote's warehouse is the store's default warehouse. It must remain an
  // enabled source for the exact Dropship OMS channel through the acceptance
  // transaction. This applies to both legacy exact-SKU validation and the
  // canonical whole-order claim preparation path.
  const warehouseAllocated = await isWarehouseEnabledForChannelWithClient(client, {
    channelId: intake.channelId,
    warehouseId: quote.warehouseId,
  });
  if (!warehouseAllocated) {
    throw new DropshipError(
      "DROPSHIP_ORDER_WAREHOUSE_NOT_ALLOCATED",
      "Dropship order acceptance requires the store's default warehouse to be enabled for the Dropship OMS channel in Channel Allocation.",
      {
        intakeId: intake.intakeId,
        channelId: intake.channelId,
        warehouseId: quote.warehouseId,
        retryable: false,
      },
    );
  }
  const lines = await resolveAcceptanceLinesWithClient(client, {
    vendor,
    storeConnectionId: input.storeConnectionId,
    rawLines: intake.normalizedPayload.lines,
    productCosts,
  });
  const productVariantIds = uniquePositiveIntegers(lines.map((line) => line.productVariantId));
  const [pricingPolicies, inventoryLevels, wallet, paymentHoldTimeoutMinutes] = await Promise.all([
    loadPricingPoliciesWithClient(client),
    inventoryValidation === "legacy_exact_sku"
      ? lockInventoryLevelsWithClient(client, { productVariantIds, warehouseId: quote.warehouseId })
      : Promise.resolve([] as InventoryLevelRow[]),
    getOrCreateWalletForUpdate(client, {
      vendorId: input.vendorId,
      currency: quote.currency,
      now: input.acceptedAt,
    }),
    loadPaymentHoldTimeoutWithClient(client, input.vendorId),
  ]);
  const plan = buildDropshipOrderAcceptancePlan({
    intake,
    vendor,
    quote,
    lines,
    pricingPolicies,
    inventory: summarizeInventoryAvailability(inventoryLevels),
    wallet,
    paymentHoldTimeoutMinutes,
    requestHash: input.requestHash,
    idempotencyKey: input.idempotencyKey,
    acceptedAt: input.acceptedAt,
    inventoryValidation,
  });
  return { plan, vendor, wallet, inventoryLevels };
}

async function loadIntakeForUpdate(
  client: PoolClient,
  input: DropshipOrderAcceptanceInput,
): Promise<DropshipAcceptanceIntakeRecord | null> {
  const result = await client.query<IntakeRow>(
    `SELECT id, channel_id, vendor_id, store_connection_id, platform,
            external_order_id, external_order_number, status, payment_hold_expires_at,
            normalized_payload, raw_payload, oms_order_id
     FROM dropship.dropship_order_intake
     WHERE id = $1
       AND vendor_id = $2
       AND store_connection_id = $3
     LIMIT 1
     FOR UPDATE`,
    [input.intakeId, input.vendorId, input.storeConnectionId],
  );
  const row = result.rows[0];
  return row ? mapIntakeRow(row) : null;
}

async function replayAcceptedOrderWithClient(
  client: PoolClient,
  input: DropshipOrderAcceptanceInput,
  intake: DropshipAcceptanceIntakeRecord,
): Promise<DropshipOrderAcceptanceResult> {
  const economics = await loadExistingEconomicsSnapshotWithClient(client, input.intakeId);
  if (!economics) {
    throw new DropshipError(
      "DROPSHIP_ORDER_ACCEPTED_SNAPSHOT_MISSING",
      "Accepted dropship order is missing its economics snapshot.",
      { intakeId: input.intakeId },
    );
  }
  if (economics.shipping_quote_snapshot_id !== input.shippingQuoteSnapshotId) {
    throw new DropshipError(
      "DROPSHIP_ORDER_ACCEPTANCE_IDEMPOTENCY_CONFLICT",
      "Accepted dropship order was replayed with a different shipping quote snapshot.",
      {
        intakeId: input.intakeId,
        acceptedShippingQuoteSnapshotId: economics.shipping_quote_snapshot_id,
        requestedShippingQuoteSnapshotId: input.shippingQuoteSnapshotId,
      },
    );
  }
  const snapshotRequestHash = typeof economics.pricing_snapshot?.requestHash === "string"
    ? economics.pricing_snapshot.requestHash
    : null;
  if (snapshotRequestHash !== input.requestHash) {
    throw new DropshipError(
      "DROPSHIP_ORDER_ACCEPTANCE_IDEMPOTENCY_CONFLICT",
      "Accepted dropship order was replayed with a different acceptance request.",
      { intakeId: input.intakeId },
    );
  }
  const ledgerEntryId = await loadOrderDebitLedgerEntryIdWithClient(client, input.intakeId);
  return {
    outcome: "accepted",
    intakeId: input.intakeId,
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    shippingQuoteSnapshotId: input.shippingQuoteSnapshotId,
    omsOrderId: intake.omsOrderId,
    walletLedgerEntryId: ledgerEntryId,
    economicsSnapshotId: economics.id,
    totalDebitCents: toSafeInteger(economics.total_debit_cents, "total_debit_cents"),
    // Not re-derived on a replay, like the advance: the ledger rows are the record.
    rewardsCents: 0,
    currency: economics.currency,
    paymentHoldExpiresAt: null,
    paymentHoldReason: null,
    // The advance, like the hold reason, is not re-derived on a replay; the
    // ledger rows of the original acceptance are the record.
    advance: null,
    idempotentReplay: true,
  };
}

async function loadVendorContextForUpdate(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
  },
): Promise<DropshipAcceptanceVendorContext | null> {
  // No partner-profile discount here: the wholesale basis is the `.ops` product
  // cost read inside this transaction (see resolveAcceptanceLinesWithClient).
  const result = await client.query<VendorContextRow>(
    `SELECT
       v.id AS vendor_id,
       v.member_id,
       v.current_plan_id,
       p.id AS membership_plan_id,
       p.tier AS membership_plan_tier,
       v.status AS vendor_status,
        v.standing_reason AS vendor_standing_reason,
        v.entitlement_status,
        sc.id AS store_connection_id,
        sc.platform AS store_platform,
        sc.status AS store_status,
        sc.setup_status,
        sc.access_token_ref,
        sc.refresh_token_ref
     FROM dropship.dropship_vendors v
     INNER JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
     LEFT JOIN membership.plans p ON p.id = v.current_plan_id
     WHERE v.id = $1
       AND sc.id = $2
     LIMIT 1
     FOR UPDATE OF v, sc`,
    [input.vendorId, input.storeConnectionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    vendorId: row.vendor_id,
    memberId: row.member_id,
    currentPlanId: row.current_plan_id,
    membershipPlanId: row.membership_plan_id,
    membershipPlanTier: row.membership_plan_tier,
    vendorStatus: row.vendor_status,
    vendorStandingReason: row.vendor_standing_reason ?? null,
    entitlementStatus: row.entitlement_status,
    storeConnectionId: row.store_connection_id,
    storeStatus: row.store_status,
    storeLaunchReady: isDropshipStoreConnectionLaunchReady({
      platform: row.store_platform,
      status: row.store_status,
      setupStatus: row.setup_status,
      hasAccessToken: row.access_token_ref !== null,
      hasRefreshToken: row.refresh_token_ref !== null,
    }),
  };
}

async function loadQuoteSnapshotWithClient(
  client: PoolClient,
  input: DropshipOrderAcceptanceInput,
): Promise<DropshipAcceptanceQuoteSnapshot> {
  const result = await client.query<QuoteRow>(
    `SELECT id, vendor_id, store_connection_id, warehouse_id, currency,
            destination_country, destination_postal_code, package_count,
            total_shipping_cents, insurance_pool_cents, quote_payload
     FROM dropship.dropship_shipping_quote_snapshots
     WHERE id = $1
       AND vendor_id = $2
       AND store_connection_id = $3
     LIMIT 1`,
    [input.shippingQuoteSnapshotId, input.vendorId, input.storeConnectionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIPPING_QUOTE_REQUIRED",
      "Dropship order acceptance requires a matching shipping quote snapshot.",
      {
        quoteSnapshotId: input.shippingQuoteSnapshotId,
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
      },
    );
  }
  return {
    quoteSnapshotId: row.id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id ?? 0,
    warehouseId: row.warehouse_id,
    currency: row.currency,
    destinationCountry: row.destination_country,
    destinationPostalCode: row.destination_postal_code,
    packageCount: row.package_count,
    totalShippingCents: toSafeInteger(row.total_shipping_cents, "total_shipping_cents"),
    insurancePoolCents: toSafeInteger(row.insurance_pool_cents, "insurance_pool_cents"),
    quotePayload: row.quote_payload ?? {},
  };
}

async function resolveAcceptanceLinesWithClient(
  client: PoolClient,
  input: {
    vendor: DropshipAcceptanceVendorContext;
    storeConnectionId: number;
    rawLines: NormalizedDropshipOrderPayload["lines"];
    productCosts: DropshipProductCostReader;
  },
): Promise<DropshipAcceptanceLineContext[]> {
  if (input.rawLines.length === 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_LINES_REQUIRED",
      "Dropship order acceptance requires at least one line.",
    );
  }

  const productVariantIds = uniquePositiveIntegers(
    input.rawLines.map((line) => line.productVariantId).filter((value): value is number => Number.isInteger(value)),
  );
  const externalListingIds = uniqueStrings(input.rawLines.map((line) => line.externalListingId));
  const externalOfferIds = uniqueStrings(input.rawLines.map((line) => line.externalOfferId));
  const skus = uniqueStrings(input.rawLines.map((line) => line.sku?.toUpperCase()));
  const result = await client.query<ListingCandidateRow>(
    `SELECT
       dl.id AS listing_id,
       dl.vendor_id,
       dl.store_connection_id,
       p.id AS product_id,
       pv.id AS product_variant_id,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT plp.product_line_id), NULL) AS product_line_ids,
       dl.status AS listing_status,
       dl.external_listing_id,
       dl.external_offer_id,
       dl.vendor_retail_price_cents,
       p.sku AS product_sku,
       pv.sku AS variant_sku,
       p.name AS product_name,
       pv.name AS variant_name,
       p.category,
       p.is_active AS product_is_active,
       pv.is_active AS variant_is_active,
       pv.sales_eligibility,
       pv.dropship_eligible,
       COALESCE((ROUND(retail_cache.price::numeric * 100))::bigint, pv.price_cents) AS catalog_retail_price_cents
     FROM dropship.dropship_vendor_listings dl
     INNER JOIN catalog.product_variants pv ON pv.id = dl.product_variant_id
     INNER JOIN catalog.products p ON p.id = pv.product_id
     LEFT JOIN catalog.product_line_products plp ON plp.product_id = p.id
     LEFT JOIN LATERAL (
       SELECT sv.price
       FROM public.shopify_variants sv
       WHERE (
           pv.shopify_variant_id IS NOT NULL
           AND sv.id::text = pv.shopify_variant_id::text
         )
         OR (
           NULLIF(BTRIM(pv.sku), '') IS NOT NULL
           AND UPPER(sv.sku) = UPPER(pv.sku)
         )
       ORDER BY CASE WHEN sv.id::text = pv.shopify_variant_id::text THEN 0 ELSE 1 END
       LIMIT 1
     ) retail_cache ON true
     WHERE dl.vendor_id = $1
       AND dl.store_connection_id = $2
       AND (
         dl.product_variant_id = ANY($3::int[])
         OR dl.external_listing_id = ANY($4::text[])
         OR dl.external_offer_id = ANY($5::text[])
         OR UPPER(pv.sku) = ANY($6::text[])
         OR UPPER(p.sku) = ANY($6::text[])
       )
     GROUP BY dl.id, p.id, pv.id, retail_cache.price`,
    [
      input.vendor.vendorId,
      input.storeConnectionId,
      productVariantIds,
      externalListingIds,
      externalOfferIds,
      skus,
    ],
  );
  const candidates = result.rows.map((row) => mapListingCandidateRow(row));
  const matchedLines = input.rawLines.map((line, index) => {
    const candidate = findCandidateForOrderLine(candidates, line);
    if (!candidate) {
      throw new DropshipError(
        "DROPSHIP_ORDER_LINE_LISTING_REQUIRED",
        "Dropship order line must resolve to a vendor-owned marketplace listing.",
        {
          lineIndex: index,
          productVariantId: line.productVariantId,
          externalListingId: line.externalListingId,
          externalOfferId: line.externalOfferId,
          sku: line.sku,
        },
      );
    }
    assertListingCandidateCanAccept(candidate, index);
    return { line, index, candidate };
  });

  // The wholesale basis is the vendor's `.ops` plan cost, read inside this
  // transaction so the debit and its evidence share one snapshot. It is the same
  // authority the vendor saw in preview; nothing else may price a live order.
  const costs = await input.productCosts.loadProductCosts({
    vendorId: input.vendor.vendorId,
    productVariantIds: uniquePositiveIntegers(matchedLines.map(({ candidate }) => candidate.productVariantId)),
  });

  return matchedLines.map(({ line, index, candidate }) => {
    const resolution = resolveAcceptanceUnitCost(costs.get(candidate.productVariantId));
    if (!resolution.ok) {
      throw new DropshipError(resolution.code, resolution.message, {
        lineIndex: index,
        productId: candidate.productId,
        productVariantId: candidate.productVariantId,
        issue: resolution.issue,
        planId: input.vendor.currentPlanId,
        // Only a failed source read is worth retrying; everything else needs a human.
        retryable: resolution.retryable,
      });
    }
    const observedRetailUnitPriceCents = line.unitRetailPriceCents
      ?? candidate.observedRetailUnitPriceCents;
    return {
      ...candidate,
      lineIndex: index,
      quantity: line.quantity,
      observedRetailUnitPriceCents: toSafeInteger(
        observedRetailUnitPriceCents,
        "observed_retail_unit_price_cents",
      ),
      wholesaleUnitCostCents: resolution.unitCostCents,
      productCostEvidence: resolution.evidence,
      externalLineItemId: line.externalLineItemId ?? null,
      title: line.title?.trim() || candidate.title,
    };
  });
}

async function loadPricingPoliciesWithClient(
  client: PoolClient,
): Promise<DropshipAcceptancePricingPolicy[]> {
  const result = await client.query<PricingPolicyRow>(
    `SELECT id, scope_type, product_line_id, product_id, product_variant_id,
            category, mode, floor_price_cents, ceiling_price_cents
     FROM dropship.dropship_pricing_policies
     WHERE is_active = true
     ORDER BY id ASC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    scopeType: row.scope_type,
    productLineId: row.product_line_id,
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    category: row.category,
    mode: row.mode,
    floorPriceCents: row.floor_price_cents === null ? null : toSafeInteger(row.floor_price_cents, "floor_price_cents"),
    ceilingPriceCents: row.ceiling_price_cents === null ? null : toSafeInteger(row.ceiling_price_cents, "ceiling_price_cents"),
  }));
}

async function lockInventoryLevelsWithClient(
  client: PoolClient,
  input: {
    productVariantIds: readonly number[];
    warehouseId: number;
  },
): Promise<InventoryLevelRow[]> {
  if (input.productVariantIds.length === 0) return [];
  const result = await client.query<InventoryLevelRow>(
    `SELECT il.id, il.warehouse_location_id, il.product_variant_id, il.variant_qty,
            il.reserved_qty, il.picked_qty, il.packed_qty
     FROM inventory.inventory_levels il
     INNER JOIN warehouse.warehouse_locations wl
       ON wl.id = il.warehouse_location_id
     WHERE il.product_variant_id = ANY($1::int[])
       AND wl.warehouse_id = $2
     ORDER BY il.product_variant_id ASC,
              (il.variant_qty - il.reserved_qty) DESC,
              il.id ASC
     FOR UPDATE`,
    [input.productVariantIds, input.warehouseId],
  );
  return result.rows;
}

async function getOrCreateWalletForUpdate(
  client: PoolClient,
  input: {
    vendorId: number;
    currency: string;
    now: Date;
  },
): Promise<DropshipAcceptanceWalletState> {
  await client.query(
    `INSERT INTO dropship.dropship_wallet_accounts
      (vendor_id, available_balance_cents, pending_balance_cents, currency, status, created_at, updated_at)
     VALUES ($1, 0, 0, $2, 'active', $3, $3)
     ON CONFLICT (vendor_id) DO NOTHING`,
    [input.vendorId, input.currency, input.now],
  );
  const result = await client.query<WalletAccountRow>(
    `SELECT id, vendor_id, available_balance_cents, pending_balance_cents, rewards_balance_cents,
            currency, status
     FROM dropship.dropship_wallet_accounts
     WHERE vendor_id = $1
     LIMIT 1
     FOR UPDATE`,
    [input.vendorId],
  );
  const row = requiredRow(result.rows[0], "Dropship wallet account load did not return a row.");
  if (row.status !== "active") {
    throw new DropshipError(
      "DROPSHIP_WALLET_ACCOUNT_NOT_ACTIVE",
      "Dropship wallet account is not active for order acceptance.",
      { vendorId: input.vendorId, walletAccountId: row.id, status: row.status },
    );
  }
  return {
    walletAccountId: row.id,
    availableBalanceCents: toSafeInteger(row.available_balance_cents, "available_balance_cents"),
    pendingBalanceCents: toSafeInteger(row.pending_balance_cents, "pending_balance_cents"),
    rewardsBalanceCents: toSafeInteger(row.rewards_balance_cents, "rewards_balance_cents"),
    spendRewardsFirst: await loadSpendRewardsFirstWithClient(client, input.vendorId),
    currency: row.currency,
    advance: await loadAdvanceContextWithClient(client, { vendorId: input.vendorId, walletAccountId: row.id }),
  };
}

/**
 * The vendor's choice for their rewards points (funding design phase 7), from
 * their wallet settings row: true applies them to orders, false saves them,
 * and null (no choice yet, or no row yet) is left for `decideRewardsSpend` to
 * read as the default, which is on (owner decision 2026-09-26).
 */
async function loadSpendRewardsFirstWithClient(client: PoolClient, vendorId: number): Promise<boolean | null> {
  const result = await client.query<{ spend_rewards_first: boolean | null }>(
    `SELECT spend_rewards_first
     FROM dropship.dropship_auto_reload_settings
     WHERE vendor_id = $1
     LIMIT 1`,
    [vendorId],
  );
  const value = result.rows[0]?.spend_rewards_first;
  return typeof value === "boolean" ? value : null;
}

/**
 * The facts the pending-ACH advance is decided from, read on this client
 * under the wallet row lock just taken, so the decision and the debit see one
 * snapshot. Null when the policy is unreadable: nothing is advanced, and
 * orders the available balance covers still flow.
 */
async function loadAdvanceContextWithClient(
  client: PoolClient,
  input: { vendorId: number; walletAccountId: number },
): Promise<DropshipAdvanceContext | null> {
  const policy = await loadAdvancePolicyWithClient(client, input.vendorId);
  if (!policy) {
    return null;
  }
  const sources = await loadAdvanceSourcesWithClient(client, input);
  return { policy, sources };
}

/**
 * How long this order may wait in payment hold.
 *
 * The staff-managed wallet policy governs (migration 0683): the hold length is
 * a platform decision, and the vendor client only ever echoed the default into
 * the per-vendor column, so the active policy row wins whenever one exists.
 * The vendor row and then the documented default are the fallbacks for a
 * database the policy migration has not reached yet.
 *
 * The policy table is probed with to_regclass first: a query against a
 * missing relation would abort this transaction, and a dyno booting ahead of
 * the release-phase migration must still accept orders.
 */
async function loadPaymentHoldTimeoutWithClient(client: PoolClient, vendorId: number): Promise<number> {
  const policyTable = await client.query<{ present: string | null }>(
    `SELECT to_regclass('dropship.dropship_wallet_policies')::text AS present`,
  );
  if (policyTable.rows[0]?.present) {
    const policy = await client.query<{ default_payment_hold_timeout_minutes: number }>(
      `SELECT default_payment_hold_timeout_minutes
       FROM dropship.dropship_wallet_policies
       WHERE is_active = true
       LIMIT 1`,
    );
    const policyMinutes = policy.rows[0]?.default_payment_hold_timeout_minutes;
    if (Number.isInteger(policyMinutes) && policyMinutes > 0) {
      return policyMinutes;
    }
  }
  const result = await client.query<AutoReloadRow>(
    `SELECT payment_hold_timeout_minutes
     FROM dropship.dropship_auto_reload_settings
     WHERE vendor_id = $1
     LIMIT 1`,
    [vendorId],
  );
  return result.rows[0]?.payment_hold_timeout_minutes ?? DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES;
}

async function markIntakePaymentHoldWithClient(
  client: PoolClient,
  input: {
    plan: AcceptanceFinancialPlan;
    input: DropshipOrderAcceptanceInput;
    wallet: DropshipAcceptanceWalletState;
    /** What the order was short by and why pending money did not cover it; null for a standing hold. */
    shortfall: { gapCents: number; advanceRefusal: DropshipAdvanceRefusal } | null;
    /** What rewards would pay of this order (funding design phase 7). */
    rewardsCents: number;
  },
): Promise<void> {
  await client.query(
    `UPDATE dropship.dropship_order_intake
     SET status = 'payment_hold',
         payment_hold_expires_at = $2,
         rejection_reason = NULL,
         updated_at = $3
     WHERE id = $1`,
    [
      input.plan.intakeId,
      input.plan.paymentHoldExpiresAt,
      input.input.acceptedAt,
    ],
  );
  await recordAcceptanceAuditEventWithClient(client, {
    plan: input.plan,
    input: input.input,
    eventType: "order_acceptance_payment_hold",
    severity: "warning",
    payload: {
      totalDebitCents: input.plan.totalDebitCents,
      availableBalanceCents: input.wallet.availableBalanceCents,
      rewardsBalanceCents: input.wallet.rewardsBalanceCents,
      rewardsCents: input.rewardsCents,
      pendingBalanceCents: input.wallet.pendingBalanceCents,
      paymentHoldExpiresAt: input.plan.paymentHoldExpiresAt?.toISOString() ?? null,
      shortfall: input.shortfall,
      requestHash: input.input.requestHash,
    },
  });
}

async function createOmsOrderWithClient(
  client: PoolClient,
  plan: DropshipOrderAcceptancePlan,
  intake: DropshipAcceptanceIntakeRecord,
  options: { stagedForCanonicalAcceptance?: boolean } = {},
): Promise<number> {
  const omsState = options.stagedForCanonicalAcceptance
    ? "'pending', 'pending'"
    : "'confirmed', 'paid'";
  const result = await client.query<OmsOrderRow>(
    `INSERT INTO oms.oms_orders
      (channel_id, external_order_id, external_order_number, status,
       financial_status, fulfillment_status, customer_name, customer_email,
       customer_phone, ship_to_name, ship_to_address1, ship_to_address2,
       ship_to_city, ship_to_state, ship_to_zip, ship_to_country,
       subtotal_cents, shipping_cents, tax_cents, discount_cents, total_cents,
       currency, warehouse_id, raw_payload, notes, tags, ordered_at, created_at, updated_at)
     VALUES ($1, $2, $3, ${omsState},
       'unfulfilled', $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12, $13,
       $14, $15, 0, 0, $16,
       $17, $18, $19::jsonb, $20, $21, $22, $23, $23)
     ON CONFLICT (channel_id, external_order_id) DO NOTHING
     RETURNING id`,
    [
      plan.channelId,
      plan.omsExternalOrderId,
      plan.externalOrderNumber ?? intake.externalOrderId,
      plan.shipTo.name,
      plan.shipTo.email || null,
      plan.shipTo.phone || null,
      plan.shipTo.name,
      plan.shipTo.address1,
      plan.shipTo.address2 || null,
      plan.shipTo.city,
      plan.shipTo.region,
      plan.shipTo.postalCode,
      plan.shipTo.country,
      plan.wholesaleSubtotalCents,
      plan.shippingCents,
      plan.totalDebitCents,
      plan.currency,
      plan.warehouseId,
      JSON.stringify({
        dropship: {
          intakeId: plan.intakeId,
          vendorId: plan.vendorId,
          storeConnectionId: plan.storeConnectionId,
          externalOrderId: intake.externalOrderId,
          ...(options.stagedForCanonicalAcceptance
            ? { acceptanceState: "inventory_claim_required" }
            : {}),
          // The service the buyer paid the marketplace for. Kept on the OMS
          // order (not only inside the marketplace blob) so fulfillment and
          // reconciliation can read it without parsing platform-specific
          // payloads. oms_orders has no migrated column for it, so raw_payload
          // is the durable home until a dedicated column ships.
          buyerShippingServiceCode: intake.normalizedPayload.buyerShippingServiceCode ?? null,
        },
        marketplace: intake.rawPayload,
      }),
      `Dropship order intake ${plan.intakeId}`,
      JSON.stringify(["dropship", `vendor:${plan.vendorId}`, `store:${plan.storeConnectionId}`]),
      readOrderedAt(intake.normalizedPayload) ?? plan.acceptedAt,
      plan.acceptedAt,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new DropshipError(
      "DROPSHIP_OMS_ORDER_ID_CONFLICT",
      "Dropship OMS order external key already exists before intake acceptance.",
      {
        intakeId: plan.intakeId,
        channelId: plan.channelId,
        omsExternalOrderId: plan.omsExternalOrderId,
      },
    );
  }
  const omsOrderId = toSafeInteger(row.id, "oms_order_id");
  await client.query(
    `INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
     VALUES ($1, 'created', $2::jsonb, $3)`,
    [
      omsOrderId,
      JSON.stringify({
        source: "dropship_order_acceptance",
        intakeId: plan.intakeId,
        storeConnectionId: plan.storeConnectionId,
      }),
      plan.acceptedAt,
    ],
  );
  return omsOrderId;
}

async function createOmsOrderLinesWithClient(
  client: PoolClient,
  input: {
    omsOrderId: number;
    plan: DropshipOrderAcceptancePlan;
  },
): Promise<OmsLineRow[]> {
  const rows: OmsLineRow[] = [];
  for (const line of input.plan.lines) {
    const result = await client.query<OmsLineRow>(
      `INSERT INTO oms.oms_order_lines
        (order_id, product_variant_id, external_line_item_id, external_product_id,
         sku, title, variant_title, quantity, paid_price_cents, total_price_cents,
         total_discount_cents, taxable, requires_shipping, fulfillable_quantity,
         fulfillment_provider, fulfillment_status, order_number, created_at, updated_at)
       VALUES ($1, $2, $3, $4,
         $5, $6, NULL, $7, $8, $9,
         0, true, true, $7,
         'dropship', 'unfulfilled', $10, $11, $11)
       RETURNING id, product_variant_id, quantity`,
      [
        input.omsOrderId,
        line.productVariantId,
        line.externalLineItemId,
        String(line.productId),
        line.sku,
        line.title,
        line.quantity,
        line.wholesaleUnitCostCents,
        line.wholesaleLineTotalCents,
        input.plan.externalOrderNumber,
        input.plan.acceptedAt,
      ],
    );
    rows.push(requiredRow(result.rows[0], "OMS order line insert did not return a row."));
  }
  return rows;
}

/**
 * P0.1a — availability VALIDATION only (read-only, no writes).
 *
 * The predecessor (`reserveInventoryWithClient`) raw-SQL-incremented
 * `inventory.inventory_levels.reserved_qty` and hand-wrote ledger rows here,
 * bypassing `reserveForOrder()` (BOUNDARIES.md violation). WMS sync then
 * reserved the same demand again with WMS ids — its per-item dedup cannot see
 * these rows — so every accepted order was DOUBLE-reserved, and because no
 * release path existed for the acceptance-time rows, the reserved stock
 * leaked permanently (prod-confirmed 2026-07-02).
 *
 * Reservation now happens exactly once, at WMS sync (dispatched immediately
 * after acceptance). This check keeps the same rejection semantics at
 * acceptance time — same error code — using the same availability math.
 */
function validateInventoryAvailability(
  input: {
    plan: DropshipOrderAcceptancePlan;
    inventoryLevels: InventoryLevelRow[];
    omsOrderId: number;
  },
): void {
  const requiredByVariant = aggregatePlanQuantityByVariant(input.plan.lines);
  for (const [productVariantId, requiredQty] of requiredByVariant) {
    let remaining = requiredQty;
    const levels = input.inventoryLevels.filter((level) => level.product_variant_id === productVariantId);
    for (const level of levels) {
      if (remaining <= 0) break;
      const available = inventoryLevelAvailableQty(level);
      if (available <= 0) continue;
      remaining -= Math.min(available, remaining);
    }
    if (remaining > 0) {
      throw new DropshipError(
        "DROPSHIP_ORDER_INVENTORY_RESERVATION_FAILED",
        "Dropship order inventory availability validation failed.",
        { productVariantId, requiredQty, remaining },
      );
    }
  }
}

interface WalletDebitOutcome {
  /** The `order_debit` row when cash paid any part of the order; else the `rewards_spent` row. */
  ledgerEntryId: number;
  /** The part of the debit the rewards balance paid, and its row (funding design phase 7). */
  rewardsCents: number;
  rewardsLedgerEntryId: number | null;
  advance: DropshipOrderAcceptanceAdvanceSummary | null;
}

/**
 * The order debit: rewards first (funding design phase 7), cash second, and
 * the advance fee when pending money paid part of the cash.
 *
 * Every row posts in this transaction under the wallet row lock. The
 * rewards part never exceeds the rewards balance the decision was made from,
 * and the available balance may end negative only by what the funding
 * decision allowed: the eligible pending credits, never past the cap, fee
 * included. Both bounds are checked again here against the same locked
 * balances, so a caller that hands in a decision for another wallet state
 * cannot overdraw either balance. Each row references the same intake under
 * its own reference type (the ledger's reference index is unique) and its
 * own idempotency key. An order the rewards balance pays in full posts no
 * cash row: the ledger refuses a zero amount.
 */
async function debitWalletWithClient(
  client: PoolClient,
  input: {
    plan: AcceptanceFinancialPlan;
    wallet: DropshipAcceptanceWalletState;
    input: DropshipOrderAcceptanceInput;
    funding: DropshipAcceptanceFundingDecision;
  },
): Promise<WalletDebitOutcome> {
  if (input.funding.outcome !== "accepted") {
    throw new DropshipError(
      "DROPSHIP_WALLET_DEBIT_WITHOUT_FUNDING",
      "Dropship wallet debit was attempted for an order the funding decision holds.",
      { intakeId: input.plan.intakeId, walletAccountId: input.wallet.walletAccountId, classification: "fatal" },
    );
  }
  const rewardsCents = input.funding.rewardsCents;
  if (
    !Number.isSafeInteger(rewardsCents)
    || rewardsCents < 0
    || rewardsCents > input.wallet.rewardsBalanceCents
    || rewardsCents > input.plan.totalDebitCents
  ) {
    throw new DropshipError(
      "DROPSHIP_WALLET_REWARDS_DEBIT_INVALID",
      "Dropship wallet rewards debit does not fit the locked rewards balance or the order.",
      {
        intakeId: input.plan.intakeId,
        walletAccountId: input.wallet.walletAccountId,
        rewardsCents,
        rewardsBalanceCents: input.wallet.rewardsBalanceCents,
        totalDebitCents: input.plan.totalDebitCents,
        classification: "fatal",
      },
    );
  }
  const cashDebitCents = input.plan.totalDebitCents - rewardsCents;
  const rewardsAfterCents = input.wallet.rewardsBalanceCents - rewardsCents;
  const advance = input.funding.source === "advance" ? input.funding.advance : null;
  const feeCents = advance?.feeCents ?? 0;
  const availableAfterDebitCents = input.wallet.availableBalanceCents - cashDebitCents;
  const availableAfterFeeCents = availableAfterDebitCents - feeCents;
  const overdraftFloorCents = advance ? -Math.min(advance.eligiblePendingCents, advance.capCents) : 0;
  // An order rewards pay in full draws nothing from cash, so a balance already
  // negative (an exposure being collected) is not this order's to refuse.
  if (cashDebitCents + feeCents > 0 && availableAfterFeeCents < overdraftFloorCents) {
    throw new DropshipError(
      "DROPSHIP_WALLET_INSUFFICIENT_FUNDS",
      "Dropship wallet has insufficient available funds for order acceptance.",
      {
        intakeId: input.plan.intakeId,
        walletAccountId: input.wallet.walletAccountId,
        availableBalanceCents: input.wallet.availableBalanceCents,
        requiredCents: cashDebitCents + feeCents,
        rewardsCents,
        overdraftFloorCents,
      },
    );
  }
  await client.query(
    `UPDATE dropship.dropship_wallet_accounts
     SET available_balance_cents = $3,
         updated_at = $4,
         rewards_balance_cents = $5
     WHERE id = $1
       AND vendor_id = $2`,
    [
      input.wallet.walletAccountId,
      input.plan.vendorId,
      availableAfterFeeCents,
      input.input.acceptedAt,
      rewardsAfterCents,
    ],
  );
  const orderDebitKey = buildWalletLedgerIdempotencyKey(input.plan.intakeId, input.input.idempotencyKey);
  const debitMetadata = {
    requestHash: input.input.requestHash,
    submittedIdempotencyKey: input.input.idempotencyKey,
    shippingQuoteSnapshotId: input.plan.shippingQuoteSnapshotId,
    wholesaleSubtotalCents: input.plan.wholesaleSubtotalCents,
    shippingCents: input.plan.shippingCents,
    feesCents: input.plan.feesCents,
    // A single ledger row must explain its amount: the cost authority and the
    // content hash of the .ops inputs that produced it.
    pricingSnapshotVersion: DROPSHIP_PRICING_SNAPSHOT_VERSION,
    costAuthority: "shellz_club_ops_product_cost",
    costEvidenceHash: input.plan.costEvidenceHash,
    // The order's whole cost and how it split between the two balances.
    totalDebitCents: input.plan.totalDebitCents,
    rewardsSpentCents: rewardsCents,
    cashDebitCents,
    // And, when pending money paid part of it, exactly what was advanced
    // against what, so the negative balance it leaves is explained.
    advance: advance
      ? {
          advanceCents: advance.advanceCents,
          feeCents: advance.feeCents,
          feeBps: advance.feeBps,
          capCents: advance.capCents,
          capSource: advance.capSource,
          eligiblePendingCents: advance.eligiblePendingCents,
          exposureBeforeCents: advance.exposureBeforeCents,
          exposureAfterCents: advance.exposureAfterCents,
          fundingMethodIds: advance.fundingMethodIds,
        }
      : null,
  };
  let orderDebitLedgerEntryId: number | null = null;
  if (cashDebitCents > 0) {
    const result = await client.query<WalletLedgerIdRow>(
      `INSERT INTO dropship.dropship_wallet_ledger
        (wallet_account_id, vendor_id, type, status, amount_cents, currency,
         available_balance_after_cents, pending_balance_after_cents,
         reference_type, reference_id, idempotency_key, metadata, created_at, settled_at,
         rewards_balance_after_cents)
       VALUES ($1, $2, 'order_debit', 'settled', $3, $4,
         $5, $6,
         'order_intake', $7, $8, $9::jsonb, $10, $10,
         $11)
       RETURNING id`,
      [
        input.wallet.walletAccountId,
        input.plan.vendorId,
        -cashDebitCents,
        input.plan.currency,
        availableAfterDebitCents,
        input.wallet.pendingBalanceCents,
        String(input.plan.intakeId),
        orderDebitKey,
        JSON.stringify(debitMetadata),
        input.input.acceptedAt,
        rewardsAfterCents,
      ],
    );
    orderDebitLedgerEntryId = requiredRow(result.rows[0], "Dropship wallet ledger insert did not return a row.").id;
    await client.query(
      `INSERT INTO dropship.dropship_audit_events
        (vendor_id, entity_type, entity_id, event_type,
         actor_type, actor_id, severity, payload, created_at)
       VALUES ($1, 'dropship_wallet_ledger', $2, 'wallet_order_debited',
               'system', NULL, 'info', $3::jsonb, $4)`,
      [
        input.plan.vendorId,
        String(orderDebitLedgerEntryId),
        JSON.stringify({
          intakeId: input.plan.intakeId,
          walletAccountId: input.wallet.walletAccountId,
          amountCents: -cashDebitCents,
          totalDebitCents: input.plan.totalDebitCents,
          rewardsCents,
          availableBalanceBeforeCents: input.wallet.availableBalanceCents,
          availableBalanceAfterCents: availableAfterDebitCents,
          advanceCents: advance?.advanceCents ?? null,
        }),
        input.input.acceptedAt,
      ],
    );
  }
  let rewardsLedgerEntryId: number | null = null;
  if (rewardsCents > 0) {
    // The lots say which points go (migration 0705): soonest to expire
    // first. Reconciled against the balance as locked, before this spend.
    const rewardsLots = await reconcileRewardsLotsWithClient(client, {
      account: {
        walletAccountId: input.wallet.walletAccountId,
        vendorId: input.plan.vendorId,
        rewardsBalanceCents: input.wallet.rewardsBalanceCents,
      },
      cause: "rewards_spent",
      now: input.input.acceptedAt,
    });
    const result = await client.query<WalletLedgerIdRow>(
      `INSERT INTO dropship.dropship_wallet_ledger
        (wallet_account_id, vendor_id, type, status, amount_cents, currency,
         available_balance_after_cents, pending_balance_after_cents,
         reference_type, reference_id, idempotency_key, metadata, created_at, settled_at,
         rewards_balance_after_cents)
       VALUES ($1, $2, 'rewards_spent', 'settled', $3, $4,
         $5, $6,
         'order_intake_rewards', $7, $8, $9::jsonb, $10, $10,
         $11)
       RETURNING id`,
      [
        input.wallet.walletAccountId,
        input.plan.vendorId,
        -rewardsCents,
        input.plan.currency,
        availableAfterDebitCents,
        input.wallet.pendingBalanceCents,
        String(input.plan.intakeId),
        `${orderDebitKey}:rewards`,
        JSON.stringify({
          intakeId: input.plan.intakeId,
          orderDebitLedgerEntryId,
          requestHash: input.input.requestHash,
          totalDebitCents: input.plan.totalDebitCents,
          cashDebitCents,
          rewardsBalanceBeforeCents: input.wallet.rewardsBalanceCents,
        }),
        input.input.acceptedAt,
        rewardsAfterCents,
      ],
    );
    rewardsLedgerEntryId = requiredRow(result.rows[0], "Dropship wallet rewards spend insert did not return a row.").id;
    const rewardsLotTakes = await takeRewardsFromLotsWithClient(client, {
      walletAccountId: input.wallet.walletAccountId,
      lots: rewardsLots,
      amountCents: rewardsCents,
      ledgerEntryId: rewardsLedgerEntryId,
      now: input.input.acceptedAt,
    });
    await client.query(
      `INSERT INTO dropship.dropship_audit_events
        (vendor_id, entity_type, entity_id, event_type,
         actor_type, actor_id, severity, payload, created_at)
       VALUES ($1, 'dropship_wallet_ledger', $2, 'wallet_rewards_spent',
               'system', NULL, 'info', $3::jsonb, $4)`,
      [
        input.plan.vendorId,
        String(rewardsLedgerEntryId),
        JSON.stringify({
          intakeId: input.plan.intakeId,
          walletAccountId: input.wallet.walletAccountId,
          orderDebitLedgerEntryId,
          amountCents: -rewardsCents,
          totalDebitCents: input.plan.totalDebitCents,
          rewardsBalanceBeforeCents: input.wallet.rewardsBalanceCents,
          rewardsBalanceAfterCents: rewardsAfterCents,
          rewardsLotTakes,
        }),
        input.input.acceptedAt,
      ],
    );
  }
  const ledgerEntryId = orderDebitLedgerEntryId ?? rewardsLedgerEntryId;
  if (ledgerEntryId === null) {
    throw new DropshipError(
      "DROPSHIP_WALLET_DEBIT_WROTE_NOTHING",
      "Dropship wallet debit posted neither a cash row nor a rewards row.",
      { intakeId: input.plan.intakeId, walletAccountId: input.wallet.walletAccountId, classification: "fatal" },
    );
  }
  if (!advance) {
    return { ledgerEntryId, rewardsCents, rewardsLedgerEntryId, advance: null };
  }
  // A zero fee (a zero-rate policy) posts no row: the ledger refuses a zero
  // amount, and the order debit's metadata already records the advance.
  let feeLedgerEntryId: number | null = null;
  if (feeCents > 0) {
    const fee = await client.query<WalletLedgerIdRow>(
      `INSERT INTO dropship.dropship_wallet_ledger
        (wallet_account_id, vendor_id, type, status, amount_cents, currency,
         available_balance_after_cents, pending_balance_after_cents,
         reference_type, reference_id, idempotency_key, metadata, created_at, settled_at,
         rewards_balance_after_cents)
       VALUES ($1, $2, 'advance_fee', 'settled', $3, $4,
         $5, $6,
         'order_intake_advance_fee', $7, $8, $9::jsonb, $10, $10,
         $11)
       RETURNING id`,
      [
        input.wallet.walletAccountId,
        input.plan.vendorId,
        -feeCents,
        input.plan.currency,
        availableAfterFeeCents,
        input.wallet.pendingBalanceCents,
        String(input.plan.intakeId),
        `${orderDebitKey}:advance-fee`,
        JSON.stringify({
          intakeId: input.plan.intakeId,
          orderDebitLedgerEntryId: ledgerEntryId,
          advanceCents: advance.advanceCents,
          feeBps: advance.feeBps,
          feeCents: advance.feeCents,
          capCents: advance.capCents,
          capSource: advance.capSource,
          fundingMethodIds: advance.fundingMethodIds,
        }),
        input.input.acceptedAt,
        rewardsAfterCents,
      ],
    );
    feeLedgerEntryId = requiredRow(fee.rows[0], "Dropship wallet advance fee insert did not return a row.").id;
    await client.query(
      `INSERT INTO dropship.dropship_audit_events
        (vendor_id, entity_type, entity_id, event_type,
         actor_type, actor_id, severity, payload, created_at)
       VALUES ($1, 'dropship_wallet_ledger', $2, 'wallet_advance_fee_charged',
               'system', NULL, 'info', $3::jsonb, $4)`,
      [
        input.plan.vendorId,
        String(feeLedgerEntryId),
        JSON.stringify({
          intakeId: input.plan.intakeId,
          walletAccountId: input.wallet.walletAccountId,
          orderDebitLedgerEntryId: ledgerEntryId,
          amountCents: -feeCents,
          advanceCents: advance.advanceCents,
          feeBps: advance.feeBps,
          availableBalanceBeforeCents: availableAfterDebitCents,
          availableBalanceAfterCents: availableAfterFeeCents,
        }),
        input.input.acceptedAt,
      ],
    );
  }
  return {
    ledgerEntryId,
    rewardsCents,
    rewardsLedgerEntryId,
    advance: {
      advanceCents: advance.advanceCents,
      feeCents: advance.feeCents,
      feeBps: advance.feeBps,
      feeLedgerEntryId,
    },
  };
}

async function createEconomicsSnapshotWithClient(
  client: PoolClient,
  input: {
    plan: AcceptanceFinancialPlan;
    vendor: Pick<DropshipAcceptanceVendorContext, "memberId" | "membershipPlanId" | "currentPlanId">;
    omsOrderId: number;
  },
): Promise<number> {
  const result = await client.query<{ id: number }>(
    `INSERT INTO dropship.dropship_order_economics_snapshots
      (intake_id, oms_order_id, vendor_id, store_connection_id, member_id,
       membership_plan_id, shipping_quote_snapshot_id, warehouse_id, currency,
       retail_subtotal_cents, wholesale_subtotal_cents, shipping_cents,
       insurance_pool_cents, fees_cents, total_debit_cents, pricing_snapshot,
       created_at)
     VALUES ($1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12,
       $13, $14, $15, $16::jsonb,
       $17)
     RETURNING id`,
    [
      input.plan.intakeId,
      input.omsOrderId,
      input.plan.vendorId,
      input.plan.storeConnectionId,
      input.vendor.memberId,
      input.vendor.membershipPlanId ?? input.vendor.currentPlanId,
      input.plan.shippingQuoteSnapshotId,
      input.plan.warehouseId,
      input.plan.currency,
      input.plan.retailSubtotalCents,
      input.plan.wholesaleSubtotalCents,
      input.plan.shippingCents,
      input.plan.insurancePoolCents,
      input.plan.feesCents,
      input.plan.totalDebitCents,
      JSON.stringify(input.plan.pricingSnapshot),
      input.plan.acceptedAt,
    ],
  );
  return requiredRow(result.rows[0], "Dropship economics snapshot insert did not return a row.").id;
}

async function markIntakeAcceptedWithClient(
  client: PoolClient,
  input: {
    intakeId: number;
    omsOrderId: number;
    acceptedAt: Date;
  },
): Promise<void> {
  await client.query(
    `UPDATE dropship.dropship_order_intake
     SET status = 'accepted',
         payment_hold_expires_at = NULL,
         rejection_reason = NULL,
         oms_order_id = $2,
         accepted_at = $3,
         updated_at = $3
     WHERE id = $1`,
    [input.intakeId, input.omsOrderId, input.acceptedAt],
  );
}

async function recordAcceptanceAuditEventWithClient(
  client: PoolClient,
  input: {
    plan: AcceptanceFinancialPlan;
    input: DropshipOrderAcceptanceInput;
    eventType: string;
    severity: "info" | "warning" | "error";
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_order_intake', $3, $4,
             $5, $6, $7, $8::jsonb, $9)`,
    [
      input.plan.vendorId,
      input.plan.storeConnectionId,
      String(input.plan.intakeId),
      input.eventType,
      input.input.actor.actorType,
      input.input.actor.actorId ?? null,
      input.severity,
      JSON.stringify({
        idempotencyKey: input.input.idempotencyKey,
        shippingQuoteSnapshotId: input.plan.shippingQuoteSnapshotId,
        outcome: input.plan.outcome,
        ...input.payload,
      }),
      input.input.acceptedAt,
    ],
  );
}

async function loadExistingEconomicsSnapshotWithClient(
  client: PoolClient,
  intakeId: number,
): Promise<ExistingAcceptanceRow | null> {
  const result = await client.query<ExistingAcceptanceRow>(
    `SELECT id, shipping_quote_snapshot_id, total_debit_cents, currency, pricing_snapshot
     FROM dropship.dropship_order_economics_snapshots
     WHERE intake_id = $1
     LIMIT 1`,
    [intakeId],
  );
  return result.rows[0] ?? null;
}

async function loadOrderDebitLedgerEntryIdWithClient(
  client: PoolClient,
  intakeId: number,
): Promise<number | null> {
  const result = await client.query<WalletLedgerIdRow>(
    `SELECT id
     FROM dropship.dropship_wallet_ledger
     WHERE reference_type = 'order_intake'
       AND reference_id = $1
       AND type = 'order_debit'
     ORDER BY id ASC
     LIMIT 1`,
    [String(intakeId)],
  );
  if (result.rows[0]) {
    return result.rows[0].id;
  }
  // An order the rewards balance paid in full has no cash row; its
  // `rewards_spent` row is the record (funding design phase 7).
  const rewards = await client.query<WalletLedgerIdRow>(
    `SELECT id
     FROM dropship.dropship_wallet_ledger
     WHERE reference_type = 'order_intake_rewards'
       AND reference_id = $1
       AND type = 'rewards_spent'
     ORDER BY id ASC
     LIMIT 1`,
    [String(intakeId)],
  );
  return rewards.rows[0]?.id ?? null;
}

function mapIntakeRow(row: IntakeRow): DropshipAcceptanceIntakeRecord {
  if (!row.normalized_payload) {
    throw new DropshipError(
      "DROPSHIP_ORDER_INTAKE_PAYLOAD_REQUIRED",
      "Dropship order intake is missing normalized payload.",
      { intakeId: row.id },
    );
  }
  return {
    intakeId: row.id,
    channelId: row.channel_id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    externalOrderId: row.external_order_id,
    externalOrderNumber: row.external_order_number,
    status: row.status,
    normalizedPayload: row.normalized_payload,
    rawPayload: row.raw_payload ?? {},
    omsOrderId: row.oms_order_id === null ? null : toSafeInteger(row.oms_order_id, "oms_order_id"),
    paymentHoldExpiresAt: row.payment_hold_expires_at,
  };
}

function mapListingCandidateRow(
  row: ListingCandidateRow,
): Omit<
  DropshipAcceptanceLineContext,
  "lineIndex" | "quantity" | "externalLineItemId" | "wholesaleUnitCostCents" | "productCostEvidence"
> & {
  externalListingId: string | null;
  externalOfferId: string | null;
  listingStatus: string;
  productIsActive: boolean;
  variantIsActive: boolean;
  customerSellable: boolean;
  dropshipEligible: boolean;
} {
  const catalogRetailPriceCents = row.catalog_retail_price_cents === null
    ? null
    : toSafeInteger(row.catalog_retail_price_cents, "catalog_retail_price_cents");
  if (catalogRetailPriceCents === null) {
    // Retail is evidence and the pricing-policy basis, not the debit basis.
    throw new DropshipError(
      "DROPSHIP_ORDER_CATALOG_RETAIL_REQUIRED",
      "Dropship order acceptance requires a catalog retail price for retail evidence and pricing-policy checks.",
      { productVariantId: row.product_variant_id },
    );
  }
  const observedRetailUnitPriceCents = row.vendor_retail_price_cents === null
    ? catalogRetailPriceCents
    : toSafeInteger(row.vendor_retail_price_cents, "vendor_retail_price_cents");
  return {
    listingId: row.listing_id,
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    productLineIds: row.product_line_ids ?? [],
    sku: row.variant_sku ?? row.product_sku,
    title: row.variant_name || row.product_name,
    category: row.category,
    catalogRetailPriceCents,
    observedRetailUnitPriceCents,
    externalListingId: row.external_listing_id,
    externalOfferId: row.external_offer_id,
    listingStatus: row.listing_status,
    productIsActive: row.product_is_active,
    variantIsActive: row.variant_is_active,
    customerSellable: row.sales_eligibility === "sellable",
    dropshipEligible: row.dropship_eligible === true,
  };
}

function findCandidateForOrderLine(
  candidates: ReadonlyArray<ReturnType<typeof mapListingCandidateRow>>,
  line: NormalizedDropshipOrderPayload["lines"][number],
): ReturnType<typeof mapListingCandidateRow> | null {
  if (line.productVariantId) {
    return candidates.find((candidate) => candidate.productVariantId === line.productVariantId) ?? null;
  }
  if (line.externalOfferId) {
    return candidates.find((candidate) => candidate.externalOfferId === line.externalOfferId) ?? null;
  }
  if (line.externalListingId) {
    return candidates.find((candidate) => candidate.externalListingId === line.externalListingId) ?? null;
  }
  const normalizedSku = line.sku?.trim().toUpperCase();
  if (normalizedSku) {
    return candidates.find((candidate) => candidate.sku?.toUpperCase() === normalizedSku) ?? null;
  }
  return null;
}

function assertListingCandidateCanAccept(
  candidate: ReturnType<typeof mapListingCandidateRow>,
  lineIndex: number,
): void {
  if (!["active", "drift_detected", "paused"].includes(candidate.listingStatus)) {
    throw new DropshipError(
      "DROPSHIP_ORDER_LISTING_NOT_ACCEPTABLE",
      "Dropship order line listing is not in an acceptable status.",
      {
        lineIndex,
        listingId: candidate.listingId,
        listingStatus: candidate.listingStatus,
      },
    );
  }
  if (
    !candidate.productIsActive
    || !candidate.variantIsActive
    || !candidate.customerSellable
    || !candidate.dropshipEligible
  ) {
    throw new DropshipError(
      "DROPSHIP_ORDER_CATALOG_VARIANT_NOT_ELIGIBLE",
      "Dropship order line variant is not eligible for dropship acceptance.",
      {
        lineIndex,
        productId: candidate.productId,
        productVariantId: candidate.productVariantId,
        productIsActive: candidate.productIsActive,
        variantIsActive: candidate.variantIsActive,
        customerSellable: candidate.customerSellable,
        dropshipEligible: candidate.dropshipEligible,
      },
    );
  }
}

async function loadCanonicalAcceptanceStageForUpdate(
  client: PoolClient,
  intakeId: number,
): Promise<CanonicalAcceptanceStageRow | null> {
  const result = await client.query<CanonicalAcceptanceStageRow>(
    `SELECT intake_id, oms_order_id, vendor_id, store_connection_id,
            shipping_quote_snapshot_id, warehouse_id, wallet_account_id,
            state, claim_attempt_number, wms_order_id, request_hash, submitted_idempotency_key,
            actor_type, actor_id, member_id, membership_plan_id, currency,
            retail_subtotal_cents, wholesale_subtotal_cents, shipping_cents,
            insurance_pool_cents, fees_cents, total_debit_cents,
            cost_evidence_hash, pricing_snapshot, prepared_at,
            inventory_claimed_at, inventory_release_requested_at,
            inventory_released_at, inventory_release_reason, expired_at,
            finalized_at
     FROM dropship.dropship_order_acceptance_stages
     WHERE intake_id = $1
     LIMIT 1
     FOR UPDATE`,
    [intakeId],
  );
  return result.rows[0] ?? null;
}

async function requireCanonicalAcceptanceStageForUpdate(
  client: PoolClient,
  input: DropshipOrderAcceptanceInput,
  expectedOmsOrderId: number | null,
): Promise<CanonicalAcceptanceStageRow> {
  const stage = await loadCanonicalAcceptanceStageForUpdate(client, input.intakeId);
  if (!stage) {
    throw new DropshipError(
      "DROPSHIP_CANONICAL_ACCEPTANCE_STAGE_REQUIRED",
      "Canonical dropship acceptance has no durable preparation stage.",
      { intakeId: input.intakeId },
    );
  }
  assertCanonicalStageMatches(stage, input, {
    intakeId: input.intakeId,
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    omsOrderId: expectedOmsOrderId,
  });
  return stage;
}

function assertCanonicalStageMatches(
  stage: CanonicalAcceptanceStageRow,
  input: DropshipOrderAcceptanceInput,
  intake: Pick<DropshipAcceptanceIntakeRecord, "intakeId" | "vendorId" | "storeConnectionId" | "omsOrderId">,
): void {
  const stageOmsOrderId = toSafeInteger(stage.oms_order_id, "stage.oms_order_id");
  const mismatches: Record<string, unknown> = {};
  if (stage.vendor_id !== input.vendorId || intake.vendorId !== input.vendorId) {
    mismatches.vendorId = { staged: stage.vendor_id, intake: intake.vendorId, requested: input.vendorId };
  }
  if (stage.store_connection_id !== input.storeConnectionId || intake.storeConnectionId !== input.storeConnectionId) {
    mismatches.storeConnectionId = {
      staged: stage.store_connection_id,
      intake: intake.storeConnectionId,
      requested: input.storeConnectionId,
    };
  }
  if (stage.shipping_quote_snapshot_id !== input.shippingQuoteSnapshotId) {
    mismatches.shippingQuoteSnapshotId = {
      staged: stage.shipping_quote_snapshot_id,
      requested: input.shippingQuoteSnapshotId,
    };
  }
  if (stage.request_hash !== input.requestHash) {
    mismatches.requestHash = "changed";
  }
  if (intake.omsOrderId != null && intake.omsOrderId !== stageOmsOrderId) {
    mismatches.omsOrderId = { staged: stageOmsOrderId, intake: intake.omsOrderId };
  }
  if (Object.keys(mismatches).length > 0) {
    throw canonicalStageConflict(input.intakeId, mismatches);
  }
}

function assertCanonicalStageIntakeCanResume(
  intake: DropshipAcceptanceIntakeRecord,
  acceptedAt: Date,
  stageState: CanonicalAcceptanceStageRow["state"],
): void {
  if (!["received", "retrying", "failed", "payment_hold", "processing"].includes(intake.status)) {
    throw new DropshipError(
      "DROPSHIP_ORDER_INTAKE_NOT_ACCEPTABLE",
      "Dropship order intake is not in a status that can resume canonical acceptance.",
      { intakeId: intake.intakeId, status: intake.status },
    );
  }
  if (!intake.paymentHoldExpiresAt) {
    if (intake.status === "payment_hold" && stageState === "prepared") {
      throw new DropshipError(
        "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRY_REQUIRED",
        "Dropship payment hold intake is missing its expiration timestamp.",
        { intakeId: intake.intakeId },
      );
    }
    return;
  }
  if (intake.paymentHoldExpiresAt <= acceptedAt && stageState === "prepared") {
    throw new DropshipError(
      "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED",
      "Dropship payment hold expired before canonical acceptance could resume.",
      {
        intakeId: intake.intakeId,
        paymentHoldExpiresAt: intake.paymentHoldExpiresAt.toISOString(),
      },
    );
  }
}

function canonicalStageConflict(
  intakeId: number,
  mismatches: Record<string, unknown>,
): DropshipError {
  return new DropshipError(
    "DROPSHIP_ORDER_ACCEPTANCE_IDEMPOTENCY_CONFLICT",
    "Canonical dropship acceptance was replayed with state that does not match its durable stage.",
    { intakeId, mismatches },
  );
}

function canonicalPaymentHoldExpired(intake: DropshipAcceptanceIntakeRecord): DropshipError {
  if (!intake.paymentHoldExpiresAt) {
    return new DropshipError(
      "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRY_REQUIRED",
      "Dropship payment hold intake is missing its expiration timestamp.",
      { intakeId: intake.intakeId },
    );
  }
  return new DropshipError(
    "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED",
    "Dropship payment hold expired before canonical acceptance could resume.",
    {
      intakeId: intake.intakeId,
      paymentHoldExpiresAt: intake.paymentHoldExpiresAt.toISOString(),
    },
  );
}

function canonicalCompensationFromStage(
  stage: CanonicalAcceptanceStageRow,
  claimAttempt: CanonicalClaimAttemptRow,
  intake: DropshipAcceptanceIntakeRecord,
  acceptedAt: Date,
): Extract<DropshipCanonicalOrderAcceptancePreparation, { outcome: "compensation_required" }> {
  if (stage.wms_order_id == null) {
    throw canonicalStageConflict(stage.intake_id, {
      stageState: stage.state,
      wmsOrderId: "missing",
    });
  }
  const plan: AcceptanceFinancialPlan = {
    ...financialPlanFromCanonicalStage(stage, acceptedAt),
    outcome: "payment_hold",
    paymentHoldExpiresAt: intake.paymentHoldExpiresAt,
  };
  return {
    outcome: "compensation_required",
    result: {
      // Compensation restates the stage; the rewards part is not re-derived.
      ...paymentHoldResult(plan, 0),
      idempotentReplay: true,
    },
    omsOrderId: toSafeInteger(stage.oms_order_id, "stage.oms_order_id"),
    wmsOrderId: toSafeInteger(stage.wms_order_id, "stage.wms_order_id"),
    warehouseId: stage.warehouse_id,
    inventoryClaimId: normalizeNullableClaimId(claimAttempt.availability_claim_id),
  };
}

function canonicalPreparationFromStage(
  stage: CanonicalAcceptanceStageRow,
  idempotentReplay: boolean,
): DropshipCanonicalOrderAcceptancePreparation {
  return {
    outcome: "prepared",
    intakeId: stage.intake_id,
    vendorId: stage.vendor_id,
    storeConnectionId: stage.store_connection_id,
    shippingQuoteSnapshotId: stage.shipping_quote_snapshot_id,
    warehouseId: stage.warehouse_id,
    omsOrderId: toSafeInteger(stage.oms_order_id, "stage.oms_order_id"),
    idempotentReplay,
  };
}

async function insertCanonicalAcceptanceStageWithClient(
  client: PoolClient,
  input: {
    plan: DropshipOrderAcceptancePlan;
    vendor: DropshipAcceptanceVendorContext;
    wallet: DropshipAcceptanceWalletState;
    input: DropshipOrderAcceptanceInput;
    omsOrderId: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_order_acceptance_stages
      (intake_id, oms_order_id, vendor_id, store_connection_id,
       shipping_quote_snapshot_id, warehouse_id, wallet_account_id, state,
       request_hash, submitted_idempotency_key, actor_type, actor_id,
       member_id, membership_plan_id, currency, retail_subtotal_cents,
       wholesale_subtotal_cents, shipping_cents, insurance_pool_cents,
       fees_cents, total_debit_cents, cost_evidence_hash, pricing_snapshot,
       prepared_at, updated_at)
     VALUES ($1, $2, $3, $4,
       $5, $6, $7, 'prepared',
       $8, $9, $10, $11,
       $12, $13, $14, $15,
       $16, $17, $18,
       $19, $20, $21, $22::jsonb,
       $23, $23)`,
    [
      input.plan.intakeId,
      input.omsOrderId,
      input.plan.vendorId,
      input.plan.storeConnectionId,
      input.plan.shippingQuoteSnapshotId,
      input.plan.warehouseId,
      input.wallet.walletAccountId,
      input.input.requestHash,
      input.input.idempotencyKey,
      input.input.actor.actorType,
      input.input.actor.actorId ?? null,
      input.vendor.memberId,
      input.vendor.membershipPlanId ?? input.vendor.currentPlanId,
      input.plan.currency,
      input.plan.retailSubtotalCents,
      input.plan.wholesaleSubtotalCents,
      input.plan.shippingCents,
      input.plan.insurancePoolCents,
      input.plan.feesCents,
      input.plan.totalDebitCents,
      input.plan.costEvidenceHash,
      JSON.stringify(input.plan.pricingSnapshot),
      input.input.acceptedAt,
    ],
  );
}

async function markIntakeCanonicalAcceptanceProcessingWithClient(
  client: PoolClient,
  input: { intakeId: number; omsOrderId: number; updatedAt: Date },
): Promise<void> {
  await client.query(
    `UPDATE dropship.dropship_order_intake
     SET status = 'processing',
         oms_order_id = $2,
         rejection_reason = NULL,
         updated_at = $3
     WHERE id = $1`,
    [input.intakeId, input.omsOrderId, input.updatedAt],
  );
}

async function markOmsOrderAcceptedWithClient(
  client: PoolClient,
  omsOrderId: number,
  acceptedAt: Date,
): Promise<void> {
  const result = await client.query<{ id: string | number }>(
    `UPDATE oms.oms_orders
     SET status = 'confirmed',
         financial_status = 'paid',
         updated_at = $2
     WHERE id = $1
       AND status = 'pending'
       AND financial_status = 'pending'
     RETURNING id`,
    [omsOrderId, acceptedAt],
  );
  if (result.rows.length !== 1) {
    throw new DropshipError(
      "DROPSHIP_CANONICAL_OMS_STAGE_INVALID",
      "Canonical dropship acceptance could not promote its staged OMS order.",
      { omsOrderId },
    );
  }
}

function financialPlanFromCanonicalStage(
  stage: CanonicalAcceptanceStageRow,
  acceptedAt: Date,
): AcceptanceFinancialPlan {
  if (!/^[0-9a-f]{64}$/.test(stage.cost_evidence_hash)) {
    throw canonicalStageConflict(stage.intake_id, { costEvidenceHash: "invalid" });
  }
  if (!stage.pricing_snapshot || typeof stage.pricing_snapshot !== "object" || Array.isArray(stage.pricing_snapshot)) {
    throw canonicalStageConflict(stage.intake_id, { pricingSnapshot: "invalid" });
  }
  return {
    outcome: "accepted",
    intakeId: stage.intake_id,
    vendorId: stage.vendor_id,
    storeConnectionId: stage.store_connection_id,
    shippingQuoteSnapshotId: stage.shipping_quote_snapshot_id,
    warehouseId: stage.warehouse_id,
    acceptedAt,
    currency: stage.currency,
    retailSubtotalCents: toSafeInteger(stage.retail_subtotal_cents, "stage.retail_subtotal_cents"),
    wholesaleSubtotalCents: toSafeInteger(stage.wholesale_subtotal_cents, "stage.wholesale_subtotal_cents"),
    shippingCents: toSafeInteger(stage.shipping_cents, "stage.shipping_cents"),
    insurancePoolCents: toSafeInteger(stage.insurance_pool_cents, "stage.insurance_pool_cents"),
    feesCents: toSafeInteger(stage.fees_cents, "stage.fees_cents"),
    totalDebitCents: toSafeInteger(stage.total_debit_cents, "stage.total_debit_cents"),
    paymentHoldExpiresAt: null,
    paymentHoldReason: null,
    costEvidenceHash: stage.cost_evidence_hash,
    pricingSnapshot: stage.pricing_snapshot,
  };
}

function frozenAcceptanceInput(
  stage: CanonicalAcceptanceStageRow,
  acceptedAt: Date,
): DropshipOrderAcceptanceInput {
  return {
    intakeId: stage.intake_id,
    vendorId: stage.vendor_id,
    storeConnectionId: stage.store_connection_id,
    shippingQuoteSnapshotId: stage.shipping_quote_snapshot_id,
    idempotencyKey: stage.submitted_idempotency_key,
    requestHash: stage.request_hash,
    acceptedAt,
    actor: {
      actorType: stage.actor_type,
      ...(stage.actor_id ? { actorId: stage.actor_id } : {}),
    },
  };
}

/** `rewardsCents`: what rewards would pay of this order (funding design phase 7); zero when not re-derived. */
function paymentHoldResult(plan: AcceptanceFinancialPlan, rewardsCents: number): DropshipOrderAcceptanceResult {
  return {
    outcome: "payment_hold",
    intakeId: plan.intakeId,
    vendorId: plan.vendorId,
    storeConnectionId: plan.storeConnectionId,
    shippingQuoteSnapshotId: plan.shippingQuoteSnapshotId,
    omsOrderId: null,
    walletLedgerEntryId: null,
    economicsSnapshotId: null,
    totalDebitCents: plan.totalDebitCents,
    rewardsCents,
    currency: plan.currency,
    paymentHoldExpiresAt: plan.paymentHoldExpiresAt,
    paymentHoldReason: plan.paymentHoldReason,
    advance: null,
    idempotentReplay: false,
  };
}

/**
 * Eligibility at finalization. A vendor paused for funding passes here and
 * is held by the finalize step itself; every other non-active status is a
 * change that invalidates the staged acceptance.
 */
function assertVendorContextCanFinalize(vendor: DropshipAcceptanceVendorContext): void {
  if (
    vendorOrderAdmissionFor({ status: vendor.vendorStatus, standingReason: vendor.vendorStandingReason }) === "reject"
    || vendor.entitlementStatus !== "active"
    || vendor.storeStatus !== "connected"
    || !vendor.storeLaunchReady
  ) {
    throw new DropshipError(
      "DROPSHIP_ORDER_VENDOR_CONTEXT_CHANGED",
      "Dropship vendor/store eligibility changed before acceptance finalization.",
      {
        vendorId: vendor.vendorId,
        storeConnectionId: vendor.storeConnectionId,
        vendorStatus: vendor.vendorStatus,
        vendorStandingReason: vendor.vendorStandingReason,
        entitlementStatus: vendor.entitlementStatus,
        storeStatus: vendor.storeStatus,
        storeLaunchReady: vendor.storeLaunchReady,
      },
    );
  }
}

async function recordCanonicalStageAuditEventWithClient(
  client: PoolClient,
  stage: CanonicalAcceptanceStageRow,
  currentInput: DropshipOrderAcceptanceInput,
  event: {
    eventType: string;
    severity?: "info" | "warning" | "error";
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const actor = frozenAcceptanceInput(stage, currentInput.acceptedAt).actor;
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_order_intake', $3, $4,
             $5, $6, $7, $8::jsonb, $9)`,
    [
      stage.vendor_id,
      stage.store_connection_id,
      String(stage.intake_id),
      event.eventType,
      actor.actorType,
      actor.actorId ?? null,
      event.severity ?? "info",
      JSON.stringify({
        idempotencyKey: stage.submitted_idempotency_key,
        shippingQuoteSnapshotId: stage.shipping_quote_snapshot_id,
        ...event.payload,
      }),
      currentInput.acceptedAt,
    ],
  );
}

function acceptanceIntakeNotFound(input: DropshipOrderAcceptanceInput): DropshipError {
  return new DropshipError(
    "DROPSHIP_ORDER_INTAKE_NOT_FOUND",
    "Dropship order intake was not found for acceptance.",
    {
      intakeId: input.intakeId,
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
    },
  );
}

function normalizePositiveMinutes(value: number): number {
  return Number.isInteger(value) && value > 0
    ? value
    : DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES;
}

function summarizeInventoryAvailability(
  levels: readonly InventoryLevelRow[],
): DropshipAcceptanceInventoryAvailability[] {
  const byVariant = new Map<number, number>();
  for (const level of levels) {
    byVariant.set(
      level.product_variant_id,
      (byVariant.get(level.product_variant_id) ?? 0) + inventoryLevelAvailableQty(level),
    );
  }
  return [...byVariant.entries()].map(([productVariantId, availableQty]) => ({
    productVariantId,
    availableQty,
  }));
}

function inventoryLevelAvailableQty(level: InventoryLevelRow): number {
  // Picking already removes units from variant_qty; picked/packed are workflow
  // counters and must not consume the same physical units a second time.
  return Math.max(0, level.variant_qty - level.reserved_qty);
}

function aggregatePlanQuantityByVariant(
  lines: readonly DropshipOrderAcceptancePlan["lines"][number][],
): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of lines) {
    result.set(line.productVariantId, (result.get(line.productVariantId) ?? 0) + line.quantity);
  }
  return result;
}

function buildWalletLedgerIdempotencyKey(intakeId: number, submittedIdempotencyKey: string): string {
  const digest = createHash("sha256").update(submittedIdempotencyKey).digest("hex").slice(0, 32);
  return `order:${intakeId}:${digest}`;
}

function readOrderedAt(payload: NormalizedDropshipOrderPayload): Date | null {
  if (!payload.orderedAt) return null;
  const date = new Date(payload.orderedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function uniquePositiveIntegers(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

function uniqueStrings(values: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function toSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DropshipError(
      "DROPSHIP_ORDER_INTEGER_RANGE_ERROR",
      "Dropship order integer value is outside the safe runtime range.",
      { field, value: String(value) },
    );
  }
  return parsed;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}
