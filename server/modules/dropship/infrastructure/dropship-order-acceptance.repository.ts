import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import type { NormalizedDropshipOrderPayload } from "../application/dropship-order-intake-service";
import {
  buildDropshipOrderAcceptancePlan,
  calculateDiscountedWholesaleUnitCostCents,
  type DropshipAcceptanceIntakeRecord,
  type DropshipAcceptanceInventoryAvailability,
  type DropshipAcceptanceLineContext,
  type DropshipAcceptancePlanningInput,
  type DropshipAcceptancePricingPolicy,
  type DropshipAcceptanceQuoteSnapshot,
  type DropshipAcceptanceVendorContext,
  type DropshipAcceptanceWalletState,
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
  entitlement_status: string;
  store_connection_id: number;
  store_status: string;
  channel_discount_percent: number | null;
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

export class PgDropshipOrderAcceptanceRepository implements DropshipOrderAcceptanceRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async acceptOrder(input: DropshipOrderAcceptanceInput): Promise<DropshipOrderAcceptanceResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await acceptOrderWithClient(client, input);
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

  const vendor = await loadVendorContextForUpdate(client, {
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    channelId: intake.channelId,
  });
  if (!vendor) {
    throw new DropshipError(
      "DROPSHIP_ORDER_VENDOR_CONTEXT_REQUIRED",
      "Dropship vendor/store context was not found for order acceptance.",
      { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId },
    );
  }

  const quote = await loadQuoteSnapshotWithClient(client, input);
  const rawLines = intake.normalizedPayload.lines;
  const lines = await resolveAcceptanceLinesWithClient(client, {
    vendor,
    storeConnectionId: input.storeConnectionId,
    rawLines,
  });
  const productVariantIds = uniquePositiveIntegers(lines.map((line) => line.productVariantId));
  const [pricingPolicies, inventoryLevels, wallet, paymentHoldTimeoutMinutes] = await Promise.all([
    loadPricingPoliciesWithClient(client),
    lockInventoryLevelsWithClient(client, productVariantIds),
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
  });

  if (plan.outcome === "payment_hold") {
    await markIntakePaymentHoldWithClient(client, {
      plan,
      input,
      wallet,
    });
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
      currency: plan.currency,
      paymentHoldExpiresAt: plan.paymentHoldExpiresAt,
      idempotentReplay: false,
    };
  }

  const omsOrderId = await createOmsOrderWithClient(client, plan, intake);
  const omsLines = await createOmsOrderLinesWithClient(client, {
    omsOrderId,
    plan,
  });
  await reserveInventoryWithClient(client, {
    plan,
    inventoryLevels,
    omsOrderId,
    omsLines,
    actorId: input.actor.actorId ?? input.actor.actorType,
    acceptedAt: input.acceptedAt,
  });
  const walletLedgerEntryId = await debitWalletWithClient(client, {
    plan,
    wallet,
    input,
  });
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
    currency: plan.currency,
    paymentHoldExpiresAt: null,
    idempotentReplay: false,
  };
}

async function loadIntakeForUpdate(
  client: PoolClient,
  input: DropshipOrderAcceptanceInput,
): Promise<DropshipAcceptanceIntakeRecord | null> {
  const result = await client.query<IntakeRow>(
    `SELECT id, channel_id, vendor_id, store_connection_id, platform,
            external_order_id, external_order_number, status,
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
    currency: economics.currency,
    paymentHoldExpiresAt: null,
    idempotentReplay: true,
  };
}

async function loadVendorContextForUpdate(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    channelId: number;
  },
): Promise<DropshipAcceptanceVendorContext | null> {
  const result = await client.query<VendorContextRow>(
    `SELECT
       v.id AS vendor_id,
       v.member_id,
       v.current_plan_id,
       p.id AS membership_plan_id,
       p.tier AS membership_plan_tier,
       v.status AS vendor_status,
       v.entitlement_status,
       sc.id AS store_connection_id,
       sc.status AS store_status,
       pp.discount_percent AS channel_discount_percent
     FROM dropship.dropship_vendors v
     INNER JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
     LEFT JOIN membership.plans p ON p.id = v.current_plan_id
     LEFT JOIN channels.partner_profiles pp ON pp.channel_id = $3
     WHERE v.id = $1
       AND sc.id = $2
     LIMIT 1
     FOR UPDATE OF v, sc`,
    [input.vendorId, input.storeConnectionId, input.channelId],
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
    entitlementStatus: row.entitlement_status,
    storeConnectionId: row.store_connection_id,
    storeStatus: row.store_status,
    channelDiscountPercent: normalizeDiscountPercent(row.channel_discount_percent),
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
       pv.dropship_eligible,
       pv.price_cents AS catalog_retail_price_cents
     FROM dropship.dropship_vendor_listings dl
     INNER JOIN catalog.product_variants pv ON pv.id = dl.product_variant_id
     INNER JOIN catalog.products p ON p.id = pv.product_id
     LEFT JOIN catalog.product_line_products plp ON plp.product_id = p.id
     WHERE dl.vendor_id = $1
       AND dl.store_connection_id = $2
       AND (
         dl.product_variant_id = ANY($3::int[])
         OR dl.external_listing_id = ANY($4::text[])
         OR dl.external_offer_id = ANY($5::text[])
         OR UPPER(pv.sku) = ANY($6::text[])
         OR UPPER(p.sku) = ANY($6::text[])
       )
     GROUP BY dl.id, p.id, pv.id`,
    [
      input.vendor.vendorId,
      input.storeConnectionId,
      productVariantIds,
      externalListingIds,
      externalOfferIds,
      skus,
    ],
  );
  const candidates = result.rows.map((row) => mapListingCandidateRow(row, input.vendor.channelDiscountPercent));
  return input.rawLines.map((line, index) => {
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
  productVariantIds: readonly number[],
): Promise<InventoryLevelRow[]> {
  if (productVariantIds.length === 0) return [];
  const result = await client.query<InventoryLevelRow>(
    `SELECT id, warehouse_location_id, product_variant_id, variant_qty,
            reserved_qty, picked_qty, packed_qty
     FROM inventory.inventory_levels
     WHERE product_variant_id = ANY($1::int[])
     ORDER BY product_variant_id ASC,
              (variant_qty - reserved_qty - picked_qty - packed_qty) DESC,
              id ASC
     FOR UPDATE`,
    [productVariantIds],
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
    `SELECT id, vendor_id, available_balance_cents, pending_balance_cents,
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
    currency: row.currency,
  };
}

async function loadPaymentHoldTimeoutWithClient(client: PoolClient, vendorId: number): Promise<number> {
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
    plan: DropshipOrderAcceptancePlan;
    input: DropshipOrderAcceptanceInput;
    wallet: DropshipAcceptanceWalletState;
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
      pendingBalanceCents: input.wallet.pendingBalanceCents,
      paymentHoldExpiresAt: input.plan.paymentHoldExpiresAt?.toISOString() ?? null,
      requestHash: input.input.requestHash,
    },
  });
}

async function createOmsOrderWithClient(
  client: PoolClient,
  plan: DropshipOrderAcceptancePlan,
  intake: DropshipAcceptanceIntakeRecord,
): Promise<number> {
  const result = await client.query<OmsOrderRow>(
    `INSERT INTO oms.oms_orders
      (channel_id, external_order_id, external_order_number, status,
       financial_status, fulfillment_status, customer_name, customer_email,
       customer_phone, ship_to_name, ship_to_address1, ship_to_address2,
       ship_to_city, ship_to_state, ship_to_zip, ship_to_country,
       subtotal_cents, shipping_cents, tax_cents, discount_cents, total_cents,
       currency, warehouse_id, raw_payload, notes, tags, ordered_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'confirmed',
       'paid', 'unfulfilled', $4, $5,
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
         fulfillment_status, order_number, created_at, updated_at)
       VALUES ($1, $2, $3, $4,
         $5, $6, NULL, $7, $8, $9,
         0, true, true, $7,
         'unfulfilled', $10, $11, $11)
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

async function reserveInventoryWithClient(
  client: PoolClient,
  input: {
    plan: DropshipOrderAcceptancePlan;
    inventoryLevels: InventoryLevelRow[];
    omsOrderId: number;
    omsLines: OmsLineRow[];
    actorId: string;
    acceptedAt: Date;
  },
): Promise<void> {
  const requiredByVariant = aggregatePlanQuantityByVariant(input.plan.lines);
  for (const [productVariantId, requiredQty] of requiredByVariant) {
    let remaining = requiredQty;
    const levels = input.inventoryLevels.filter((level) => level.product_variant_id === productVariantId);
    for (const level of levels) {
      if (remaining <= 0) break;
      const available = inventoryLevelAvailableQty(level);
      if (available <= 0) continue;
      const reserveQty = Math.min(available, remaining);
      await client.query(
        `UPDATE inventory.inventory_levels
         SET reserved_qty = reserved_qty + $1,
             updated_at = $2
         WHERE id = $3`,
        [reserveQty, input.acceptedAt, level.id],
      );
      await client.query(
        `INSERT INTO inventory.inventory_transactions
          (product_variant_id, to_location_id, transaction_type,
           variant_qty_delta, variant_qty_before, variant_qty_after,
           source_state, target_state, reference_type, reference_id,
           notes, is_implicit, user_id, created_at)
         VALUES ($1, $2, 'reserve',
           0, $3, $3,
           'on_hand', 'committed', 'dropship_order_intake', $4,
           $5, 1, $6, $7)`,
        [
          productVariantId,
          level.warehouse_location_id,
          level.variant_qty,
          String(input.plan.intakeId),
          `Dropship OMS order ${input.omsOrderId}`,
          input.actorId,
          input.acceptedAt,
        ],
      );
      remaining -= reserveQty;
    }
    if (remaining > 0) {
      throw new DropshipError(
        "DROPSHIP_ORDER_INVENTORY_RESERVATION_FAILED",
        "Dropship order inventory reservation failed after availability validation.",
        { productVariantId, requiredQty, remaining },
      );
    }
  }
  await client.query(
    `INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
     VALUES ($1, 'inventory_reserved', $2::jsonb, $3)`,
    [
      input.omsOrderId,
      JSON.stringify({
        source: "dropship_order_acceptance",
        intakeId: input.plan.intakeId,
        reservedLines: input.omsLines.map((line) => ({
          omsOrderLineId: toSafeInteger(line.id, "oms_order_line_id"),
          productVariantId: line.product_variant_id,
          quantity: line.quantity,
        })),
      }),
      input.acceptedAt,
    ],
  );
}

async function debitWalletWithClient(
  client: PoolClient,
  input: {
    plan: DropshipOrderAcceptancePlan;
    wallet: DropshipAcceptanceWalletState;
    input: DropshipOrderAcceptanceInput;
  },
): Promise<number> {
  const nextAvailableBalanceCents = input.wallet.availableBalanceCents - input.plan.totalDebitCents;
  if (nextAvailableBalanceCents < 0) {
    throw new DropshipError(
      "DROPSHIP_WALLET_INSUFFICIENT_FUNDS",
      "Dropship wallet has insufficient available funds for order acceptance.",
      {
        intakeId: input.plan.intakeId,
        walletAccountId: input.wallet.walletAccountId,
        availableBalanceCents: input.wallet.availableBalanceCents,
        requiredCents: input.plan.totalDebitCents,
      },
    );
  }
  await client.query(
    `UPDATE dropship.dropship_wallet_accounts
     SET available_balance_cents = $3,
         updated_at = $4
     WHERE id = $1
       AND vendor_id = $2`,
    [
      input.wallet.walletAccountId,
      input.plan.vendorId,
      nextAvailableBalanceCents,
      input.input.acceptedAt,
    ],
  );
  const result = await client.query<WalletLedgerIdRow>(
    `INSERT INTO dropship.dropship_wallet_ledger
      (wallet_account_id, vendor_id, type, status, amount_cents, currency,
       available_balance_after_cents, pending_balance_after_cents,
       reference_type, reference_id, idempotency_key, metadata, created_at, settled_at)
     VALUES ($1, $2, 'order_debit', 'settled', $3, $4,
       $5, $6,
       'order_intake', $7, $8, $9::jsonb, $10, $10)
     RETURNING id`,
    [
      input.wallet.walletAccountId,
      input.plan.vendorId,
      -input.plan.totalDebitCents,
      input.plan.currency,
      nextAvailableBalanceCents,
      input.wallet.pendingBalanceCents,
      String(input.plan.intakeId),
      buildWalletLedgerIdempotencyKey(input.plan.intakeId, input.input.idempotencyKey),
      JSON.stringify({
        requestHash: input.input.requestHash,
        submittedIdempotencyKey: input.input.idempotencyKey,
        shippingQuoteSnapshotId: input.plan.shippingQuoteSnapshotId,
        wholesaleSubtotalCents: input.plan.wholesaleSubtotalCents,
        shippingCents: input.plan.shippingCents,
        feesCents: input.plan.feesCents,
      }),
      input.input.acceptedAt,
    ],
  );
  const ledgerEntryId = requiredRow(result.rows[0], "Dropship wallet ledger insert did not return a row.").id;
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, 'dropship_wallet_ledger', $2, 'wallet_order_debited',
             'system', NULL, 'info', $3::jsonb, $4)`,
    [
      input.plan.vendorId,
      String(ledgerEntryId),
      JSON.stringify({
        intakeId: input.plan.intakeId,
        walletAccountId: input.wallet.walletAccountId,
        amountCents: -input.plan.totalDebitCents,
        availableBalanceAfterCents: nextAvailableBalanceCents,
      }),
      input.input.acceptedAt,
    ],
  );
  return ledgerEntryId;
}

async function createEconomicsSnapshotWithClient(
  client: PoolClient,
  input: {
    plan: DropshipOrderAcceptancePlan;
    vendor: DropshipAcceptanceVendorContext;
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
    plan: DropshipOrderAcceptancePlan;
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
  return result.rows[0]?.id ?? null;
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
  };
}

function mapListingCandidateRow(
  row: ListingCandidateRow,
  discountPercent: number,
): Omit<DropshipAcceptanceLineContext, "lineIndex" | "quantity" | "externalLineItemId"> & {
  externalListingId: string | null;
  externalOfferId: string | null;
  listingStatus: string;
  productIsActive: boolean;
  variantIsActive: boolean;
  dropshipEligible: boolean;
} {
  const catalogRetailPriceCents = row.catalog_retail_price_cents === null
    ? null
    : toSafeInteger(row.catalog_retail_price_cents, "catalog_retail_price_cents");
  if (catalogRetailPriceCents === null) {
    throw new DropshipError(
      "DROPSHIP_ORDER_WHOLESALE_PRICE_REQUIRED",
      "Dropship order acceptance requires catalog retail price to calculate wholesale cost.",
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
    wholesaleUnitCostCents: calculateDiscountedWholesaleUnitCostCents(
      catalogRetailPriceCents,
      discountPercent,
    ),
    externalListingId: row.external_listing_id,
    externalOfferId: row.external_offer_id,
    listingStatus: row.listing_status,
    productIsActive: row.product_is_active,
    variantIsActive: row.variant_is_active,
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
  if (!candidate.productIsActive || !candidate.variantIsActive || !candidate.dropshipEligible) {
    throw new DropshipError(
      "DROPSHIP_ORDER_CATALOG_VARIANT_NOT_ELIGIBLE",
      "Dropship order line variant is not eligible for dropship acceptance.",
      {
        lineIndex,
        productId: candidate.productId,
        productVariantId: candidate.productVariantId,
        productIsActive: candidate.productIsActive,
        variantIsActive: candidate.variantIsActive,
        dropshipEligible: candidate.dropshipEligible,
      },
    );
  }
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
  return Math.max(0, level.variant_qty - level.reserved_qty - level.picked_qty - level.packed_qty);
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

function normalizeDiscountPercent(value: number | null): number {
  if (value === null) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new DropshipError(
      "DROPSHIP_WHOLESALE_DISCOUNT_INVALID",
      "Dropship OMS channel discount percent must be an integer from 0 to 100.",
      { discountPercent: value },
    );
  }
  return value;
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
