import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  allocateVendorShippingCharge,
  assertCarrierClaimOccurredAfterShipment,
  calculateAffectedWholesaleCost,
  determineInitialCarrierClaimState,
  type CarrierClaimCommandContext,
  type CarrierClaimMutationResult,
  type CarrierClaimRecord,
  type CarrierClaimRepository,
  type NormalizedCreateCarrierClaim,
} from "../application/dropship-carrier-claim-service";
import { calculateCarrierProtectionCredit } from "../application/dropship-carrier-protection-service";
import { DropshipError } from "../domain/errors";
import { resolveCarrierProtectionPolicyWithClient } from "./dropship-carrier-protection.repository";

interface ShipmentRow {
  id: number;
  order_id: number;
  status: string;
  carrier: string | null;
  service_code: string | null;
  tracking_number: string | null;
  shipped_at: Date | string | null;
  carrier_cost_cents: string | number | null;
  carrier_cost_source: string | null;
  carrier_cost_recorded_at: Date | string | null;
  warehouse_status: string;
  oms_fulfillment_order_id: string | null;
}

interface EconomicsRow {
  intake_id: number;
  vendor_id: number;
  store_connection_id: number;
  channel_id: number;
  oms_order_id: string | number;
  economics_snapshot_id: number;
  warehouse_id: number | null;
  currency: string;
  shipping_cents: string | number;
  pricing_snapshot: unknown;
  quote_payload: unknown;
}

interface AllocationRow {
  id: string | number;
  intake_id: number;
  economics_snapshot_id: number;
  oms_order_id: string | number;
  wms_order_id: number;
  wms_shipment_id: number;
  currency: string;
  order_shipping_charge_cents: string | number;
  shipment_carrier_cost_cents: string | number | null;
  total_carrier_cost_cents: string | number | null;
  allocated_shipping_charge_cents: string | number;
  allocation_method: string;
  allocation_group_hash: string;
  source_snapshot: unknown;
}

interface ClaimRow {
  id: number;
  intake_id: number;
  wms_shipment_id: number;
  event_type: CarrierClaimRecord["eventType"];
  status: string;
  policy_id: number;
  carrier_protection_assignment_id: number;
  shipping_allocation_id: string | number;
  currency: string;
  carrier: string;
  tracking_number: string;
  external_claim_id: string | null;
  wholesale_cost_snapshot_cents: string | number;
  shipping_charge_snapshot_cents: string | number;
  calculated_credit_cents: string | number;
  approved_credit_cents: string | number | null;
  occurred_at: Date | string;
  eligible_at: Date | string;
  created_at: Date | string;
}

interface CommandRow {
  id: number;
  command_type: string;
  request_hash: string;
  entity_id: string | null;
}

const CLAIM_COMMAND = "carrier_claim_created";
const SUPPORTED_CARRIER_CLAIM_CURRENCY = "USD";

export class PgDropshipCarrierClaimRepository implements CarrierClaimRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async createClaim(
    input: NormalizedCreateCarrierClaim & CarrierClaimCommandContext,
  ): Promise<CarrierClaimMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const command = await claimCommand(client, input);
      if (command.replay) {
        const record = await loadClaim(client, positiveEntityId(command.entityId));
        await client.query("COMMIT");
        return { record, idempotentReplay: true };
      }

      const targetShipment = await loadTargetShipment(client, input.wmsShipmentId);
      assertShipmentReadyForClaim(targetShipment);
      const omsOrderId = positiveStoredId(
        targetShipment.oms_fulfillment_order_id,
        "wms.orders.oms_fulfillment_order_id",
      );
      const economics = await loadEconomics(client, omsOrderId);
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [94003, economics.intake_id]);
      const currency = requireSupportedCurrency(economics.currency);

      const shipmentItems = await loadShipmentItems(client, targetShipment.id);
      const affectedWholesale = calculateAffectedWholesaleCost({
        pricingSnapshot: economics.pricing_snapshot,
        shipmentItems,
      });
      const destination = readQuoteDestination(economics.quote_payload);
      const carrier = requiredText(targetShipment.carrier, "shipment carrier");
      const service = requiredText(targetShipment.service_code, "shipment service code");
      const warehouseId = positiveStoredId(economics.warehouse_id, "economics warehouse_id");
      const shippedAt = requiredDate(targetShipment.shipped_at, "shipment shipped_at");
      assertCarrierClaimOccurredAfterShipment({ occurredAt: input.occurredAt, shippedAt });
      const trackingNumber = requiredText(targetShipment.tracking_number, "shipment tracking number");

      const match = await resolveCarrierProtectionPolicyWithClient(client, {
        eventType: input.eventType,
        channelId: positiveStoredId(economics.channel_id, "intake channel_id"),
        warehouseId,
        carrier: carrier.toUpperCase(),
        service,
        destinationCountry: destination.country,
        destinationRegion: destination.region,
        shipmentValueCents: affectedWholesale.totalCents,
        occurredAt: input.occurredAt,
      });
      if (!match) {
        throw new DropshipError(
          "DROPSHIP_CARRIER_PROTECTION_POLICY_NOT_FOUND",
          "No active carrier-protection policy matches this shipment and event.",
          { wmsShipmentId: input.wmsShipmentId, eventType: input.eventType },
        );
      }

      const shippedRows = await loadShippedOrderShipments(client, targetShipment.order_id);
      const allocationPlan = allocateVendorShippingCharge({
        orderShippingChargeCents: storedMoney(economics.shipping_cents, "economics shipping_cents"),
        shipments: shippedRows.map((row) => ({
          wmsShipmentId: row.id,
          carrierCostCents: capturedCarrierCost(row),
          costCaptured: capturedCarrierCost(row) !== null,
        })),
      });
      const allocationGroupHash = buildAllocationGroupHash({
        intakeId: economics.intake_id,
        economicsSnapshotId: economics.economics_snapshot_id,
        currency: economics.currency,
        orderShippingChargeCents: storedMoney(economics.shipping_cents, "economics shipping_cents"),
        method: allocationPlan.method,
        shipments: shippedRows,
      });
      const allocations = await ensureShippingAllocations(client, {
        economics,
        wmsOrderId: targetShipment.order_id,
        allocationPlan,
        allocationGroupHash,
        shippedRows,
        now: input.now,
      });
      const targetAllocation = allocations.find((row) => row.wms_shipment_id === targetShipment.id);
      if (!targetAllocation) {
        throw new DropshipError(
          "DROPSHIP_CARRIER_CLAIM_ALLOCATION_MISSING",
          "Affected shipment is missing from the immutable shipping allocation set.",
          { wmsShipmentId: targetShipment.id },
        );
      }

      const hasInspection = await validateRmaAndLoadInspectionState(client, {
        rmaId: input.rmaId,
        intakeId: economics.intake_id,
      });
      const initialState = determineInitialCarrierClaimState({
        eventType: input.eventType,
        policy: match.policy,
        shippedAt,
        now: input.now,
        hasInspection,
        hasExternalCarrierClaim: input.externalClaimId !== null,
      });
      const shippingChargeSnapshotCents = storedMoney(
        targetAllocation.allocated_shipping_charge_cents,
        "allocated_shipping_charge_cents",
      );
      const calculatedCreditCents = calculateCarrierProtectionCredit({
        wholesaleCostCents: affectedWholesale.totalCents,
        shippingChargeCents: shippingChargeSnapshotCents,
        policy: match.policy,
      });
      const policySnapshot = {
        version: 1,
        policy: match.policy,
        assignment: match.assignment,
      };
      const sourceSnapshot = {
        version: 1,
        currency,
        economicsSnapshotId: economics.economics_snapshot_id,
        shipment: {
          wmsShipmentId: targetShipment.id,
          wmsOrderId: targetShipment.order_id,
          carrier,
          service,
          trackingNumber,
          shippedAt: shippedAt.toISOString(),
          carrierCostCents: capturedCarrierCost(targetShipment),
          carrierCostSource: targetShipment.carrier_cost_source,
          carrierCostRecordedAt: optionalDateIso(targetShipment.carrier_cost_recorded_at),
        },
        affectedWholesale,
        shippingAllocation: {
          allocationId: storedPositiveId(targetAllocation.id, "shipping allocation id"),
          method: targetAllocation.allocation_method,
          allocationGroupHash,
          orderShippingChargeCents: storedMoney(targetAllocation.order_shipping_charge_cents, "order_shipping_charge_cents"),
          allocatedShippingChargeCents: shippingChargeSnapshotCents,
          shipmentCarrierCostCents: optionalStoredMoney(targetAllocation.shipment_carrier_cost_cents, "shipment_carrier_cost_cents"),
          totalCarrierCostCents: optionalStoredMoney(targetAllocation.total_carrier_cost_cents, "total_carrier_cost_cents"),
        },
        destination,
      };

      const inserted = await client.query<ClaimRow>(
        `INSERT INTO dropship.dropship_carrier_claims
          (rma_id, intake_id, wms_shipment_id, carrier, tracking_number, currency, status, event_type,
           policy_id, carrier_protection_assignment_id, shipping_allocation_id,
           policy_snapshot, source_snapshot, wholesale_cost_snapshot_cents,
           shipping_charge_snapshot_cents, calculated_credit_cents, approved_credit_cents,
           external_claim_id, claim_amount_cents, insurance_pool_credit_cents,
           occurred_at, eligible_at, filed_at, idempotency_key, request_hash,
           actor_type, actor_id, metadata, created_at, updated_at)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,
           $9,$10,$11,$12::jsonb,$13::jsonb,$14,
           $15,$16,NULL,$17,$16,NULL,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26,$26)
         RETURNING *`,
        [
          input.rmaId,
          economics.intake_id,
          targetShipment.id,
          carrier,
          trackingNumber,
          currency,
          initialState.status,
          input.eventType,
          match.policy.policyId,
          match.assignment.assignmentId,
          storedPositiveId(targetAllocation.id, "shipping allocation id"),
          JSON.stringify(policySnapshot),
          JSON.stringify(sourceSnapshot),
          affectedWholesale.totalCents,
          shippingChargeSnapshotCents,
          calculatedCreditCents,
          input.externalClaimId,
          input.occurredAt,
          initialState.eligibleAt,
          input.externalClaimId ? input.now : null,
          input.idempotencyKey,
          input.requestHash,
          input.actor.actorType,
          input.actor.actorId ?? null,
          JSON.stringify({ version: 1, notes: input.notes }),
          input.now,
        ],
      );
      const record = mapClaim(required(inserted.rows[0], "Carrier claim insert returned no row."));
      await finishCommand(client, command.id, record.claimId, input.now);
      const auditResult = await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         VALUES ($1,$2,'dropship_carrier_claim',$3,'carrier_claim_created',
           $4,$5,'info',$6::jsonb,$7)`,
        [
          economics.vendor_id,
          economics.store_connection_id,
          String(record.claimId),
          input.actor.actorType,
          input.actor.actorId ?? null,
          JSON.stringify({
            wmsShipmentId: targetShipment.id,
            eventType: input.eventType,
            policyId: match.policy.policyId,
            assignmentId: match.assignment.assignmentId,
            wholesaleCostSnapshotCents: affectedWholesale.totalCents,
            shippingChargeSnapshotCents,
            calculatedCreditCents,
            status: initialState.status,
          }),
          input.now,
        ],
      );
      assertOneRowAffected(auditResult.rowCount, "Carrier claim audit event was not persisted.");
      await client.query("COMMIT");
      return { record, idempotentReplay: false };
    } catch (error) {
      await rollback(client);
      throw mapClaimError(error);
    } finally {
      client.release();
    }
  }

  async listClaims(limit: number): Promise<CarrierClaimRecord[]> {
    const result = await this.dbPool.query<ClaimRow>(
      `${claimSelect}
       WHERE policy_id IS NOT NULL AND wms_shipment_id IS NOT NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapClaim);
  }
}

const claimSelect = `SELECT id, intake_id, wms_shipment_id, event_type, status, policy_id,
  carrier_protection_assignment_id, shipping_allocation_id, currency, carrier, tracking_number,
  external_claim_id, wholesale_cost_snapshot_cents, shipping_charge_snapshot_cents,
  calculated_credit_cents, approved_credit_cents, occurred_at, eligible_at, created_at
  FROM dropship.dropship_carrier_claims`;

async function loadTargetShipment(client: PoolClient, shipmentId: number): Promise<ShipmentRow> {
  const result = await client.query<ShipmentRow>(
    `SELECT os.id, os.order_id, os.status, os.carrier, os.service_code, os.tracking_number,
            os.shipped_at, os.carrier_cost_cents, os.carrier_cost_source,
            os.carrier_cost_recorded_at, wo.warehouse_status, wo.oms_fulfillment_order_id
     FROM wms.outbound_shipments os
     JOIN wms.orders wo ON wo.id = os.order_id
     WHERE os.id = $1
     FOR SHARE OF os, wo`,
    [shipmentId],
  );
  return required(result.rows[0], "Affected WMS shipment was not found.");
}

function assertShipmentReadyForClaim(shipment: ShipmentRow): void {
  if (shipment.status !== "shipped" || shipment.warehouse_status !== "shipped") {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_SHIPMENT_NOT_FINAL",
      "Carrier claim intake requires a shipped fulfillment and a fully shipped WMS order.",
      { shipmentStatus: shipment.status, orderStatus: shipment.warehouse_status },
    );
  }
}

async function loadEconomics(client: PoolClient, omsOrderId: number): Promise<EconomicsRow> {
  const result = await client.query<EconomicsRow>(
    `SELECT i.id AS intake_id, i.vendor_id, i.store_connection_id, i.channel_id,
            i.oms_order_id, e.id AS economics_snapshot_id, e.warehouse_id,
            e.currency, e.shipping_cents, e.pricing_snapshot, q.quote_payload
     FROM dropship.dropship_order_intake i
     JOIN dropship.dropship_order_economics_snapshots e ON e.intake_id = i.id
     JOIN dropship.dropship_shipping_quote_snapshots q ON q.id = e.shipping_quote_snapshot_id
     WHERE i.oms_order_id = $1 AND e.oms_order_id = $1
     FOR SHARE OF i, e, q`,
    [omsOrderId],
  );
  return required(result.rows[0], "Accepted dropship economics snapshot was not found for this shipment.");
}

async function loadShipmentItems(
  client: PoolClient,
  shipmentId: number,
): Promise<Array<{ productVariantId: number; quantity: number }>> {
  const result = await client.query<{ product_variant_id: number | null; quantity: string | number }>(
    `SELECT osi.product_variant_id, SUM(osi.qty)::bigint AS quantity
     FROM wms.outbound_shipment_items osi
     WHERE osi.shipment_id = $1 AND osi.qty > 0
     GROUP BY osi.product_variant_id
     ORDER BY osi.product_variant_id`,
    [shipmentId],
  );
  return result.rows.map((row) => ({
    productVariantId: positiveStoredId(row.product_variant_id, "shipment product_variant_id"),
    quantity: positiveStoredId(row.quantity, "shipment item quantity"),
  }));
}

async function loadShippedOrderShipments(client: PoolClient, wmsOrderId: number): Promise<ShipmentRow[]> {
  const result = await client.query<ShipmentRow>(
    `SELECT os.id, os.order_id, os.status, os.carrier, os.service_code, os.tracking_number,
            os.shipped_at, os.carrier_cost_cents, os.carrier_cost_source,
            os.carrier_cost_recorded_at, wo.warehouse_status, wo.oms_fulfillment_order_id
     FROM wms.outbound_shipments os
     JOIN wms.orders wo ON wo.id = os.order_id
     WHERE os.order_id = $1
       AND os.status = 'shipped'
      ORDER BY os.id
     FOR SHARE OF os, wo`,
    [wmsOrderId],
  );
  return result.rows;
}

async function ensureShippingAllocations(
  client: PoolClient,
  input: {
    economics: EconomicsRow;
    wmsOrderId: number;
    allocationPlan: ReturnType<typeof allocateVendorShippingCharge>;
    allocationGroupHash: string;
    shippedRows: ShipmentRow[];
    now: Date;
  },
): Promise<AllocationRow[]> {
  const existing = await client.query<AllocationRow>(
    `SELECT * FROM dropship.dropship_shipment_shipping_allocations
     WHERE intake_id = $1 ORDER BY wms_shipment_id FOR SHARE`,
    [input.economics.intake_id],
  );
  if (existing.rows.length > 0) {
    assertShippingAllocationRowsMatch(existing.rows, input);
    return existing.rows;
  }

  const sourceSnapshot = {
    version: 1,
    allocationGroupHash: input.allocationGroupHash,
    method: input.allocationPlan.method,
    shipments: input.shippedRows.map((row) => ({
      wmsShipmentId: row.id,
      carrierCostCents: capturedCarrierCost(row),
      carrierCostSource: row.carrier_cost_source,
      carrierCostRecordedAt: optionalDateIso(row.carrier_cost_recorded_at),
    })),
  };
  for (const allocation of input.allocationPlan.allocations) {
    const inserted = await client.query(
      `INSERT INTO dropship.dropship_shipment_shipping_allocations
        (intake_id, economics_snapshot_id, oms_order_id, wms_order_id, wms_shipment_id,
         currency, allocation_method, order_shipping_charge_cents,
         shipment_carrier_cost_cents, total_carrier_cost_cents,
         allocated_shipping_charge_cents, allocation_group_hash, source_snapshot, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
      [
        input.economics.intake_id,
        input.economics.economics_snapshot_id,
        positiveStoredId(input.economics.oms_order_id, "economics oms_order_id"),
        input.wmsOrderId,
        allocation.wmsShipmentId,
        normalizeCurrency(input.economics.currency),
        input.allocationPlan.method,
        storedMoney(input.economics.shipping_cents, "economics shipping_cents"),
        allocation.carrierCostCents,
        input.allocationPlan.totalCarrierCostCents,
        allocation.allocatedShippingChargeCents,
        input.allocationGroupHash,
        JSON.stringify(sourceSnapshot),
        input.now,
      ],
    );
    assertOneRowAffected(
      inserted.rowCount,
      `Shipping allocation was not persisted for WMS shipment ${allocation.wmsShipmentId}.`,
    );
  }
  const inserted = await client.query<AllocationRow>(
    `SELECT * FROM dropship.dropship_shipment_shipping_allocations
     WHERE intake_id = $1 ORDER BY wms_shipment_id FOR SHARE`,
    [input.economics.intake_id],
  );
  assertShippingAllocationRowsMatch(inserted.rows, input);
  return inserted.rows;
}

function assertShippingAllocationRowsMatch(
  rows: AllocationRow[],
  input: {
    economics: EconomicsRow;
    wmsOrderId: number;
    allocationPlan: ReturnType<typeof allocateVendorShippingCharge>;
    allocationGroupHash: string;
    shippedRows: ShipmentRow[];
  },
): void {
  const expectedAllocations = [...input.allocationPlan.allocations]
    .sort((left, right) => left.wmsShipmentId - right.wmsShipmentId);
  const actualRows = [...rows].sort((left, right) => left.wms_shipment_id - right.wms_shipment_id);
  const expectedShipmentIds = expectedAllocations.map((row) => row.wmsShipmentId);
  const allocatedShipmentIds = actualRows.map((row) => row.wms_shipment_id);
  const expectedCurrency = requireSupportedCurrency(input.economics.currency);
  const expectedOrderShippingCents = storedMoney(
    input.economics.shipping_cents,
    "economics shipping_cents",
  );
  const expectedOmsOrderId = positiveStoredId(
    input.economics.oms_order_id,
    "economics oms_order_id",
  );

  const valid = actualRows.length === expectedAllocations.length
    && actualRows.every((row, index) => {
      const expected = expectedAllocations[index];
      return row.wms_shipment_id === expected.wmsShipmentId
        && positiveStoredId(row.intake_id, "shipping allocation intake_id") === input.economics.intake_id
        && positiveStoredId(row.economics_snapshot_id, "shipping allocation economics_snapshot_id") === input.economics.economics_snapshot_id
        && positiveStoredId(row.oms_order_id, "shipping allocation oms_order_id") === expectedOmsOrderId
        && positiveStoredId(row.wms_order_id, "shipping allocation wms_order_id") === input.wmsOrderId
        && normalizeCurrency(row.currency) === expectedCurrency
        && row.allocation_method === input.allocationPlan.method
        && row.allocation_group_hash === input.allocationGroupHash
        && storedMoney(row.order_shipping_charge_cents, "shipping allocation order_shipping_charge_cents") === expectedOrderShippingCents
        && optionalStoredMoney(row.shipment_carrier_cost_cents, "shipping allocation shipment_carrier_cost_cents") === expected.carrierCostCents
        && optionalStoredMoney(row.total_carrier_cost_cents, "shipping allocation total_carrier_cost_cents") === input.allocationPlan.totalCarrierCostCents
        && storedMoney(row.allocated_shipping_charge_cents, "shipping allocation allocated_shipping_charge_cents") === expected.allocatedShippingChargeCents;
    });
  if (!valid) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_ALLOCATION_STALE",
      "Immutable shipping allocations do not match the authoritative order, shipment, cost, or charge snapshot.",
      { intakeId: input.economics.intake_id, expectedShipmentIds, allocatedShipmentIds },
    );
  }
}

async function validateRmaAndLoadInspectionState(
  client: PoolClient,
  input: { rmaId: number | null; intakeId: number },
): Promise<boolean> {
  if (input.rmaId === null) return false;
  const result = await client.query<{ intake_id: number | null; inspected: boolean }>(
    `SELECT r.intake_id,
            EXISTS (SELECT 1 FROM dropship.dropship_rma_inspections ri WHERE ri.rma_id = r.id) AS inspected
     FROM dropship.dropship_rmas r
     WHERE r.id = $1
     FOR SHARE`,
    [input.rmaId],
  );
  const row = required(result.rows[0], "Referenced RMA was not found.");
  if (row.intake_id !== input.intakeId) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_RMA_ORDER_MISMATCH",
      "Referenced RMA does not belong to the affected dropship order.",
      { rmaId: input.rmaId, intakeId: input.intakeId, rmaIntakeId: row.intake_id },
    );
  }
  return row.inspected;
}

async function claimCommand(
  client: PoolClient,
  input: CarrierClaimCommandContext,
): Promise<{ id: number; entityId: string | null; replay: boolean }> {
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO dropship.dropship_admin_config_commands
      (command_type, idempotency_key, request_hash, entity_type, actor_type, actor_id, created_at)
     VALUES ($1,$2,$3,$1,$4,$5,$6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [CLAIM_COMMAND, input.idempotencyKey, input.requestHash, input.actor.actorType, input.actor.actorId ?? null, input.now],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, entityId: null, replay: false };
  const existing = await client.query<CommandRow>(
    `SELECT id, command_type, request_hash, entity_id
     FROM dropship.dropship_admin_config_commands
     WHERE idempotency_key = $1
     FOR UPDATE`,
    [input.idempotencyKey],
  );
  const row = required(existing.rows[0], "Carrier claim idempotency command was not found.");
  if (row.command_type !== CLAIM_COMMAND || row.request_hash !== input.requestHash) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_IDEMPOTENCY_CONFLICT",
      "Idempotency key was reused for a different carrier claim request.",
    );
  }
  if (!row.entity_id) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_COMMAND_INCOMPLETE",
      "Carrier claim command replay is incomplete.",
    );
  }
  return { id: row.id, entityId: row.entity_id, replay: true };
}

async function finishCommand(client: PoolClient, commandId: number, claimId: number, now: Date): Promise<void> {
  const result = await client.query(
    `UPDATE dropship.dropship_admin_config_commands
     SET entity_type = 'dropship_carrier_claim', entity_id = $2, completed_at = $3
     WHERE id = $1`,
    [commandId, String(claimId), now],
  );
  assertOneRowAffected(result.rowCount, "Carrier claim idempotency command was not completed.");
}

async function loadClaim(client: PoolClient, claimId: number): Promise<CarrierClaimRecord> {
  const result = await client.query<ClaimRow>(`${claimSelect} WHERE id = $1`, [claimId]);
  return mapClaim(required(result.rows[0], "Carrier claim was not found."));
}

function mapClaim(row: ClaimRow): CarrierClaimRecord {
  return {
    claimId: positiveStoredId(row.id, "carrier claim id"),
    intakeId: positiveStoredId(row.intake_id, "carrier claim intake_id"),
    wmsShipmentId: positiveStoredId(row.wms_shipment_id, "carrier claim wms_shipment_id"),
    eventType: row.event_type,
    status: row.status,
    policyId: positiveStoredId(row.policy_id, "carrier claim policy_id"),
    assignmentId: positiveStoredId(row.carrier_protection_assignment_id, "carrier claim assignment_id"),
    shippingAllocationId: storedPositiveId(row.shipping_allocation_id, "carrier claim shipping_allocation_id"),
    currency: normalizeCurrency(row.currency),
    carrier: requiredText(row.carrier, "carrier claim carrier"),
    trackingNumber: requiredText(row.tracking_number, "carrier claim tracking_number"),
    externalClaimId: row.external_claim_id,
    wholesaleCostSnapshotCents: storedMoney(row.wholesale_cost_snapshot_cents, "wholesale_cost_snapshot_cents"),
    shippingChargeSnapshotCents: storedMoney(row.shipping_charge_snapshot_cents, "shipping_charge_snapshot_cents"),
    calculatedCreditCents: storedMoney(row.calculated_credit_cents, "calculated_credit_cents"),
    approvedCreditCents: optionalStoredMoney(row.approved_credit_cents, "approved_credit_cents"),
    occurredAt: requiredDate(row.occurred_at, "carrier claim occurred_at"),
    eligibleAt: requiredDate(row.eligible_at, "carrier claim eligible_at"),
    createdAt: requiredDate(row.created_at, "carrier claim created_at"),
  };
}

function buildAllocationGroupHash(input: {
  intakeId: number;
  economicsSnapshotId: number;
  currency: string;
  orderShippingChargeCents: number;
  method: string;
  shipments: ShipmentRow[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    intakeId: input.intakeId,
    economicsSnapshotId: input.economicsSnapshotId,
    currency: normalizeCurrency(input.currency),
    orderShippingChargeCents: input.orderShippingChargeCents,
    method: input.method,
    shipments: input.shipments.map((row) => ({
      wmsShipmentId: row.id,
      carrierCostCents: capturedCarrierCost(row),
      carrierCostSource: row.carrier_cost_source,
      carrierCostRecordedAt: optionalDateIso(row.carrier_cost_recorded_at),
    })),
  })).digest("hex");
}

function capturedCarrierCost(row: ShipmentRow): number | null {
  if (!row.carrier_cost_source || !row.carrier_cost_recorded_at) return null;
  const cost = optionalStoredMoney(row.carrier_cost_cents, "shipment carrier_cost_cents");
  return cost !== null && cost > 0 ? cost : null;
}

function readQuoteDestination(value: unknown): { country: string; region: string | null } {
  if (!value || typeof value !== "object") {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_QUOTE_DESTINATION_REQUIRED", "Accepted shipping quote has no destination snapshot.");
  }
  const destination = (value as { destination?: unknown }).destination;
  if (!destination || typeof destination !== "object") {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_QUOTE_DESTINATION_REQUIRED", "Accepted shipping quote has no destination snapshot.");
  }
  const country = requiredText((destination as { country?: unknown }).country, "quote destination country").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_QUOTE_DESTINATION_INVALID", "Accepted shipping quote destination country is invalid.");
  }
  const rawRegion = (destination as { region?: unknown }).region;
  const region = typeof rawRegion === "string" && rawRegion.trim() ? rawRegion.trim().toUpperCase() : null;
  return { country, region };
}

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_CURRENCY_INVALID", "Accepted order currency is invalid.");
  }
  return currency;
}

function requireSupportedCurrency(value: string): string {
  const currency = normalizeCurrency(value);
  if (currency !== SUPPORTED_CARRIER_CLAIM_CURRENCY) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_CURRENCY_UNSUPPORTED",
      `Carrier-protection policy amounts currently support ${SUPPORTED_CARRIER_CLAIM_CURRENCY} only.`,
      { currency },
    );
  }
  return currency;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_SOURCE_INCOMPLETE", `${field} is required for carrier claim intake.`);
  }
  return value.trim();
}

function requiredDate(value: Date | string | null, field: string): Date {
  const parsed = value instanceof Date ? value : value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_SOURCE_INCOMPLETE", `${field} is missing or invalid.`);
  }
  return parsed;
}

function optionalDateIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return requiredDate(value, "carrier cost recorded_at").toISOString();
}

function positiveStoredId(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_SOURCE_INCOMPLETE", `${field} must be a positive integer.`);
  }
  return parsed;
}

function storedPositiveId(value: string | number, field: string): number {
  return positiveStoredId(value, field);
}

function storedMoney(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_STORED_MONEY_INVALID", `${field} is not valid integer cents.`);
  }
  return parsed;
}

function optionalStoredMoney(value: string | number | null, field: string): number | null {
  return value == null ? null : storedMoney(value, field);
}

function positiveEntityId(value: string | null): number {
  return positiveStoredId(value, "carrier claim command entity_id");
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_NOT_FOUND", message);
  }
  return value;
}

function assertOneRowAffected(rowCount: number | null, message: string): void {
  if (rowCount !== 1) {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_WRITE_INCOMPLETE", message, { rowCount });
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
}

function mapClaimError(error: unknown): unknown {
  if (error instanceof DropshipError) return error;
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "23505") {
      return new DropshipError(
        "DROPSHIP_CARRIER_CLAIM_CONFLICT",
        "A carrier claim already exists for this shipment event or idempotency key.",
      );
    }
    if (code === "23503") {
      return new DropshipError("DROPSHIP_CARRIER_CLAIM_REFERENCE_NOT_FOUND", "Referenced shipment, RMA, policy, or allocation was not found.");
    }
    if (code === "23514") {
      return new DropshipError("DROPSHIP_CARRIER_CLAIM_IMMUTABLE", "Carrier claim financial snapshots are immutable.");
    }
    if (code === "40001" || code === "40P01") {
      return new DropshipError("DROPSHIP_CARRIER_CLAIM_CONCURRENT_RETRY", "Carrier claim intake conflicted with another update; retry with the same idempotency key.");
    }
  }
  return error;
}
