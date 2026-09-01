import { eq, sql } from "drizzle-orm";
import {
  demandEvidenceSnapshots,
  idempotencyKeys,
  promiseSafetyPolicyHeads,
  promiseSafetyPolicyVersions,
} from "@shared/schema";
import {
  INVENTORY_DEMAND_EVIDENCE_MAX_AGE_HOURS,
  INVENTORY_DEMAND_METHOD_VERSION,
  INVENTORY_DEMAND_MIN_ACTIVE_DAYS,
  INVENTORY_DEMAND_MIN_CONSUMPTION_UNITS,
  INVENTORY_DEMAND_MIN_OBSERVED_DAYS,
  INVENTORY_DEMAND_MIN_SOURCE_EVENTS,
  INVENTORY_DEMAND_OBSERVATION_DAYS,
  INVENTORY_DEMAND_RECENCY_DAYS,
  promiseSafetyAdminViewSchema,
  refreshDemandEvidenceAdminResultSchema,
  type PromiseSafetyAdminScope,
  type PromiseSafetyAdminValue,
  type PromiseSafetyAdminView,
  type PromiseSafetyPolicyHeadAdmin,
  type PromiseSafetyPolicyVersionAdmin,
  type RefreshDemandEvidenceAdminResult,
} from "@shared/types/inventory-promise-safety-admin";

import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import { sqlIntegerArray } from "../../../infrastructure/postgres-array";
import type {
  InventoryPromiseSafetyAdminStore,
  RefreshDemandEvidenceCommand,
  UpdatePromiseSafetyPolicyDraftCommand,
} from "../application/inventory-promise-safety-admin.service";
import {
  calculatePromiseSafetyPolicyDefinitionHash,
  InventoryAvailabilityMasterDataError,
} from "../domain/inventory-availability-master-data.contracts";
import {
  DEMAND_TRUST_REASON,
  planDemandEvidenceSnapshots,
  type DemandConsumptionEvent,
} from "../domain/inventory-demand-evidence";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const DEMAND_REFRESH_LOCK_NAMESPACE = 918424;
const IDEMPOTENCY_LOCK_NAMESPACE = 918420;
const DEMAND_REFRESH_RECEIPT_PREFIX = "inventory-demand-evidence:";
const POLICY_UPDATE_RECEIPT_PREFIX = "inventory-promise-safety-update:";
const SAFETY_POLICY_LOCK_NAMESPACE = 918423;

export class PostgresInventoryPromiseSafetyAdminStore
implements InventoryPromiseSafetyAdminStore {
  constructor(private readonly database: typeof db = db) {}

  async getPromiseSafetyAdminView(productId: number): Promise<PromiseSafetyAdminView | null> {
    const productRows = rows(await this.database.execute(sql`
      SELECT id, sku, name
      FROM catalog.products
      WHERE id = ${productId}
        AND is_active = true
      LIMIT 1
    `));
    if (productRows.length === 0) return null;

    const variantRows = rows(await this.database.execute(sql`
      SELECT id, sku, name, units_per_variant, sales_eligibility, is_active
      FROM catalog.product_variants
      WHERE product_id = ${productId}
        AND requires_shipping = true
        AND COALESCE(track_inventory, true) = true
      ORDER BY units_per_variant, id
    `));
    const variantIds = variantRows.map((row) => positiveInteger(row.id, "variant.id"));
    const warehouseRows = rows(await this.database.execute(sql`
      SELECT id, code, name, warehouse_type, inventory_source_type
      FROM warehouse.warehouses
      WHERE is_active = 1
      ORDER BY code, id
    `));

    const policyRows = variantIds.length === 0 ? [] : rows(await this.database.execute(sql`
      SELECT
        head.scope_key,
        head.revision,
        pointer.pointer_type,
        policy.id AS policy_id,
        policy.version,
        policy.lifecycle_status,
        policy.scope_type,
        policy.product_variant_id,
        policy.warehouse_id,
        policy.policy_mode,
        policy.fixed_units,
        policy.days_of_cover_milli_days,
        policy.untrusted_demand_fallback_units,
        policy.demand_method_version,
        policy.definition_hash,
        policy.change_reason,
        policy.created_by,
        policy.created_at,
        policy.updated_at
      FROM inventory.promise_safety_policy_heads AS head
      CROSS JOIN LATERAL (
        VALUES ('active', head.active_policy_id), ('draft', head.draft_policy_id)
      ) AS pointer(pointer_type, policy_id)
      JOIN inventory.promise_safety_policy_versions AS policy ON policy.id = pointer.policy_id
      WHERE policy.scope_key = 'business'
         OR policy.product_variant_id = ANY(${sqlIntegerArray(variantIds)})
      ORDER BY head.scope_key, pointer.pointer_type
    `));

    const evidenceRows = variantIds.length === 0 ? [] : rows(await this.database.execute(sql`
      SELECT DISTINCT ON (evidence.product_variant_id, evidence.warehouse_id)
        evidence.id,
        evidence.product_variant_id,
        evidence.warehouse_id,
        evidence.window_started_at,
        evidence.window_ended_at,
        evidence.irreversible_consumption_units,
        evidence.observed_days,
        evidence.daily_demand_milli_units,
        evidence.trust_status,
        evidence.trust_reasons,
        evidence.method_version,
        evidence.input_fingerprint,
        evidence.override_by,
        evidence.override_reason,
        evidence.override_expires_at,
        evidence.calculated_at
      FROM inventory.demand_evidence_snapshots AS evidence
      WHERE evidence.product_variant_id = ANY(${sqlIntegerArray(variantIds)})
        AND evidence.warehouse_id IS NOT NULL
        AND evidence.method_version = ${INVENTORY_DEMAND_METHOD_VERSION}
      ORDER BY evidence.product_variant_id,
               evidence.warehouse_id,
               evidence.calculated_at DESC,
               evidence.id DESC
    `));

    return promiseSafetyAdminViewSchema.parse({
      product: {
        id: positiveInteger(productRows[0].id, "product.id"),
        sku: nullableText(productRows[0].sku),
        name: String(productRows[0].name),
      },
      variants: variantRows.map((row) => ({
        id: positiveInteger(row.id, "variant.id"),
        sku: nullableText(row.sku),
        name: String(row.name),
        unitsPerVariant: positiveInteger(row.units_per_variant, "variant.unitsPerVariant"),
        salesEligibility: String(row.sales_eligibility ?? "sellable"),
        isActive: Boolean(row.is_active),
      })),
      warehouses: warehouseRows.map((row) => ({
        id: positiveInteger(row.id, "warehouse.id"),
        code: String(row.code),
        name: String(row.name),
        warehouseType: String(row.warehouse_type),
        inventorySourceType: String(row.inventory_source_type),
      })),
      policyHeads: mapPolicyHeads(policyRows),
      demandMethod: demandMethodContract(),
      demandEvidence: evidenceRows.map((row) => ({
        evidenceId: String(row.id),
        productVariantId: positiveInteger(row.product_variant_id, "evidence.productVariantId"),
        warehouseId: positiveInteger(row.warehouse_id, "evidence.warehouseId"),
        windowStartedAt: iso(row.window_started_at, "evidence.windowStartedAt"),
        windowEndedAt: iso(row.window_ended_at, "evidence.windowEndedAt"),
        irreversibleConsumptionUnits: String(row.irreversible_consumption_units),
        observedDays: nonnegativeInteger(row.observed_days, "evidence.observedDays"),
        dailyDemandMilliUnits: String(row.daily_demand_milli_units),
        trustStatus: String(row.trust_status),
        trustReasons: stringArray(row.trust_reasons),
        methodVersion: String(row.method_version),
        inputFingerprint: String(row.input_fingerprint),
        overrideBy: nullableText(row.override_by),
        overrideReason: nullableText(row.override_reason),
        overrideExpiresAt: row.override_expires_at == null
          ? null
          : iso(row.override_expires_at, "evidence.overrideExpiresAt"),
        calculatedAt: iso(row.calculated_at, "evidence.calculatedAt"),
      })),
    });
  }

  async updatePromiseSafetyPolicyDraft(
    command: UpdatePromiseSafetyPolicyDraftCommand,
  ) {
    return this.database.transaction(async (tx) => {
      const receiptKey = `${POLICY_UPDATE_RECEIPT_PREFIX}${command.idempotencyKey}`;
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${IDEMPOTENCY_LOCK_NAMESPACE},
          hashtext(${command.idempotencyKey})
        )
      `);
      const replay = await loadPolicyUpdateReplay(tx, receiptKey, command.requestHash);
      if (replay) return replay;
      await assertPolicyUpdateKeyIsUnique(tx, command.idempotencyKey);
      await tx.insert(idempotencyKeys).values({
        key: receiptKey,
        requestHash: command.requestHash,
        responseBody: null,
        createdAt: command.occurredAt,
        expiresAt: null,
      });

      const policyRows = rows(await tx.execute(sql`
        SELECT
          policy.id,
          policy.scope_key,
          policy.scope_type,
          policy.product_variant_id,
          policy.warehouse_id,
          policy.version,
          policy.lifecycle_status,
          policy.definition_hash,
          policy.policy_mode,
          policy.fixed_units,
          policy.days_of_cover_milli_days,
          policy.untrusted_demand_fallback_units,
          policy.demand_method_version,
          policy.change_reason,
          policy.created_by,
          policy.created_at,
          policy.updated_at,
          head.revision,
          head.draft_policy_id
        FROM inventory.promise_safety_policy_versions AS policy
        JOIN inventory.promise_safety_policy_heads AS head ON head.scope_key = policy.scope_key
        WHERE policy.id = ${command.policyId}
        FOR UPDATE OF policy, head
      `));
      const policy = policyRows[0];
      if (!policy) throw stalePolicyDraft();
      const scopeKey = String(policy.scope_key);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${SAFETY_POLICY_LOCK_NAMESPACE},
          hashtext(${scopeKey})
        )
      `);
      if (
        Number(policy.draft_policy_id) !== command.policyId
        || Number(policy.version) !== command.expectedVersion
        || String(policy.lifecycle_status) !== "draft"
        || String(policy.definition_hash) !== command.expectedDefinitionHash
        || String(policy.revision) !== command.expectedHeadRevision
      ) {
        throw stalePolicyDraft();
      }
      const scope = policyScope(policy);
      const before = mapPolicy({ ...policy, policy_id: policy.id });
      const definitionHash = calculatePromiseSafetyPolicyDefinitionHash({
        scope,
        value: command.value,
      });
      await tx.update(promiseSafetyPolicyVersions).set({
        ...safetyPolicyColumns(command.value),
        definitionHash,
        changeReason: command.changeReason,
        updatedAt: command.occurredAt,
      }).where(eq(promiseSafetyPolicyVersions.id, command.policyId));
      await tx.update(promiseSafetyPolicyHeads).set({
        revision: sql`${promiseSafetyPolicyHeads.revision} + 1`,
        updatedBy: command.actorId,
        updateReason: command.changeReason,
        updatedAt: command.occurredAt,
      }).where(eq(promiseSafetyPolicyHeads.scopeKey, scopeKey));
      const result = {
        policyId: command.policyId,
        version: command.expectedVersion,
        scopeKey,
        definitionHash,
        alreadyApplied: false,
      };
      await persistAuditEvent(tx, {
        actor: command.actorId,
        action: "inventory_availability.promise_safety_policy.draft_updated",
        target: `inventory.promise_safety_policy:${command.policyId}`,
        changes: {
          before: {
            scope: before.scope,
            value: before.value,
            definitionHash: before.definitionHash,
            changeReason: before.changeReason,
          },
          after: {
            scope,
            value: command.value,
            definitionHash,
            changeReason: command.changeReason,
          },
        },
        context: {
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          previousHeadRevision: command.expectedHeadRevision,
          nextHeadRevision: (BigInt(command.expectedHeadRevision) + BigInt(1)).toString(),
          runtimeAuthorityChanged: false,
        },
      }, {
        timestamp: command.occurredAt,
        emitStructuredLog: false,
      });
      await tx.update(idempotencyKeys).set({
        responseBody: {
          commandType: "promise_safety_policy_draft_update",
          result,
        },
      }).where(eq(idempotencyKeys.key, receiptKey));
      return result;
    });
  }

  async refreshDemandEvidence(
    command: RefreshDemandEvidenceCommand,
  ): Promise<RefreshDemandEvidenceAdminResult> {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const receiptKey = `${DEMAND_REFRESH_RECEIPT_PREFIX}${command.idempotencyKey}`;
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${IDEMPOTENCY_LOCK_NAMESPACE},
          hashtext(${command.idempotencyKey})
        )
      `);
      const replay = await loadRefreshReplay(tx, receiptKey, command.requestHash);
      if (replay) return replay;
      await assertDemandRefreshKeyIsUnique(tx, command.idempotencyKey);
      await tx.insert(idempotencyKeys).values({
        key: receiptKey,
        requestHash: command.requestHash,
        responseBody: null,
        createdAt: command.calculatedAt,
        expiresAt: null,
      });
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(${DEMAND_REFRESH_LOCK_NAMESPACE}, ${command.productId})
      `);

      const resourceRows = rows(await tx.execute(sql`
        SELECT variant.id AS product_variant_id,
               warehouse.id AS warehouse_id,
               variant.created_at AS variant_created_at,
               warehouse.created_at AS warehouse_created_at
        FROM catalog.product_variants AS variant
        CROSS JOIN warehouse.warehouses AS warehouse
        WHERE variant.product_id = ${command.productId}
          AND variant.is_active = true
          AND variant.requires_shipping = true
          AND COALESCE(variant.track_inventory, true) = true
          AND warehouse.is_active = 1
        ORDER BY variant.id, warehouse.id
      `));
      if (resourceRows.length === 0) {
        const productRows = rows(await tx.execute(sql`
          SELECT id FROM catalog.products WHERE id = ${command.productId} AND is_active = true
        `));
        if (productRows.length === 0) {
          throw new InventoryAvailabilityMasterDataError(
            404,
            "INVENTORY_PROMISE_SAFETY_PRODUCT_NOT_FOUND",
            "The selected inventory-planning product was not found.",
          );
        }
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_DEMAND_EVIDENCE_NO_RESOURCES",
          "The selected product has no active variant and warehouse resources.",
        );
      }
      const productVariantIds = [...new Set(resourceRows.map((row) =>
        positiveInteger(row.product_variant_id, "resource.productVariantId")))];
      const warehouseIds = [...new Set(resourceRows.map((row) =>
        positiveInteger(row.warehouse_id, "resource.warehouseId")))];
      const resources = resourceRows.map((row) => ({
        productVariantId: positiveInteger(row.product_variant_id, "resource.productVariantId"),
        warehouseId: positiveInteger(row.warehouse_id, "resource.warehouseId"),
        observationStartedAt: laterDate(
          date(row.variant_created_at, "resource.variantCreatedAt"),
          date(row.warehouse_created_at, "resource.warehouseCreatedAt"),
        ),
      }));
      const events = await loadDemandConsumptionEvents(
        tx,
        productVariantIds,
        command.windowStartedAt,
        command.windowEndedAt,
      );
      const planned = planDemandEvidenceSnapshots({
        resources,
        windowStartedAt: command.windowStartedAt,
        windowEndedAt: command.windowEndedAt,
        calculatedAt: command.calculatedAt,
        events,
      });

      let createdSnapshots = 0;
      for (const snapshot of planned) {
        const created = await tx.insert(demandEvidenceSnapshots).values({
          productVariantId: snapshot.productVariantId,
          warehouseId: snapshot.warehouseId,
          windowStartedAt: snapshot.windowStartedAt,
          windowEndedAt: snapshot.windowEndedAt,
          irreversibleConsumptionUnits: snapshot.irreversibleConsumptionUnits,
          observedDays: snapshot.observedDays,
          dailyDemandMilliUnits: snapshot.dailyDemandMilliUnits,
          trustStatus: snapshot.trustStatus,
          trustReasons: snapshot.trustReasons,
          methodVersion: snapshot.methodVersion,
          inputFingerprint: snapshot.inputFingerprint,
          overrideBy: null,
          overrideReason: null,
          overrideExpiresAt: null,
          calculatedAt: snapshot.calculatedAt,
          createdAt: snapshot.calculatedAt,
        }).onConflictDoNothing().returning({ id: demandEvidenceSnapshots.id });
        createdSnapshots += created.length;
      }
      const trustedSnapshots = planned.filter((snapshot) => snapshot.trustStatus === "trusted").length;
      const result = refreshDemandEvidenceAdminResultSchema.parse({
        productId: command.productId,
        methodVersion: INVENTORY_DEMAND_METHOD_VERSION,
        windowStartedAt: command.windowStartedAt.toISOString(),
        windowEndedAt: command.windowEndedAt.toISOString(),
        calculatedAt: command.calculatedAt.toISOString(),
        createdSnapshots,
        reusedSnapshots: planned.length - createdSnapshots,
        trustedSnapshots,
        untrustedSnapshots: planned.length - trustedSnapshots,
        alreadyApplied: false,
      });
      await persistAuditEvent(tx, {
        actor: command.actorId,
        action: "inventory_availability.demand_evidence.refreshed",
        target: `catalog.product:${command.productId}`,
        changes: {
          before: null,
          after: {
            methodVersion: INVENTORY_DEMAND_METHOD_VERSION,
            windowStartedAt: result.windowStartedAt,
            windowEndedAt: result.windowEndedAt,
            createdSnapshots: result.createdSnapshots,
            reusedSnapshots: result.reusedSnapshots,
            trustedSnapshots: result.trustedSnapshots,
            untrustedSnapshots: result.untrustedSnapshots,
          },
        },
        context: {
          changeReason: command.changeReason,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          consumptionEventCount: events.length,
          runtimeAuthorityChanged: false,
        },
      }, {
        timestamp: command.calculatedAt,
        emitStructuredLog: false,
      });
      await tx.update(idempotencyKeys).set({
        responseBody: {
          commandType: "inventory_demand_evidence_refresh",
          result,
        },
      }).where(eq(idempotencyKeys.key, receiptKey));
      return result;
    });
  }
}

async function loadDemandConsumptionEvents(
  tx: Transaction,
  productVariantIds: number[],
  windowStartedAt: Date,
  windowEndedAt: Date,
): Promise<DemandConsumptionEvent[]> {
  const physicalRows = rows(await tx.execute(sql`
    WITH physical AS (
      SELECT
        item.id,
        item.physical_shipment_id,
        item.legacy_wms_shipment_item_id,
        item.shipment_item_purpose,
        item.quantity_shipped,
        COALESCE(
          item.product_variant_id,
          plan_line.product_variant_id,
          legacy_item.product_variant_id,
          item_sku_variant.id
        )
          AS product_variant_id,
        COALESCE(
          request_from_item.warehouse_id,
          request_from_package.warehouse_id,
          source_location.warehouse_id,
          plan_order.warehouse_id,
          legacy_order.warehouse_id
        ) AS warehouse_id,
        COALESCE(resolved_warehouse.inventory_source_type, 'internal') AS inventory_source_type,
        package.status AS shipment_status,
        COALESCE(package.ship_date, package.created_at) AS occurred_at,
        ship_ledger.id AS ship_ledger_id
      FROM wms.effective_physical_shipment_items AS item
      JOIN wms.physical_shipments AS package ON package.id = item.physical_shipment_id
      LEFT JOIN wms.shipment_request_items AS request_item
        ON request_item.id = item.shipment_request_item_id
      LEFT JOIN wms.shipment_requests AS request_from_item
        ON request_from_item.id = request_item.shipment_request_id
      LEFT JOIN wms.shipment_requests AS request_from_package
        ON request_from_package.id = package.shipment_request_id
      LEFT JOIN wms.fulfillment_plan_lines AS plan_line
        ON plan_line.id = item.fulfillment_plan_line_id
      LEFT JOIN wms.fulfillment_plans AS plan
        ON plan.id = plan_line.fulfillment_plan_id
      LEFT JOIN wms.orders AS plan_order ON plan_order.id = plan.wms_order_id
      LEFT JOIN wms.outbound_shipment_items AS legacy_item
        ON legacy_item.id = item.legacy_wms_shipment_item_id
      LEFT JOIN catalog.product_variants AS item_sku_variant
        ON item_sku_variant.is_active = true
       AND UPPER(item_sku_variant.sku) = UPPER(item.sku)
      LEFT JOIN warehouse.warehouse_locations AS source_location
        ON source_location.id = legacy_item.from_location_id
      LEFT JOIN wms.outbound_shipments AS legacy_shipment
        ON legacy_shipment.id = legacy_item.shipment_id
      LEFT JOIN wms.orders AS legacy_order ON legacy_order.id = legacy_shipment.order_id
      LEFT JOIN warehouse.warehouses AS resolved_warehouse
        ON resolved_warehouse.id = COALESCE(
          request_from_item.warehouse_id,
          request_from_package.warehouse_id,
          source_location.warehouse_id,
          plan_order.warehouse_id,
          legacy_order.warehouse_id
        )
      LEFT JOIN LATERAL (
        SELECT inventory_tx.id
        FROM inventory.inventory_transactions AS inventory_tx
        WHERE inventory_tx.shipment_item_id = item.legacy_wms_shipment_item_id
          AND inventory_tx.transaction_type = 'ship'
          AND inventory_tx.voided_at IS NULL
        ORDER BY inventory_tx.id
        LIMIT 1
      ) AS ship_ledger ON true
      WHERE COALESCE(package.ship_date, package.created_at) >= ${windowStartedAt}
        AND COALESCE(package.ship_date, package.created_at) < ${windowEndedAt}
        AND package.status IN ('shipped', 'returned', 'review')
        AND item.shipment_item_purpose <> 'omission_correction'
    )
    SELECT *
    FROM physical
    WHERE product_variant_id = ANY(${sqlIntegerArray(productVariantIds)})
       OR product_variant_id IS NULL
    ORDER BY id
  `));
  const ledgerGapRows = rows(await tx.execute(sql`
    SELECT
      inventory_tx.id,
      inventory_tx.shipment_item_id,
      COALESCE(
        inventory_tx.product_variant_id,
        legacy_item.product_variant_id,
        ledger_sku_variant.id
      ) AS product_variant_id,
      COALESCE(source_location.warehouse_id, target_order.warehouse_id) AS warehouse_id,
      ABS(inventory_tx.variant_qty_delta) AS quantity_shipped,
      inventory_tx.created_at AS occurred_at,
      COALESCE(legacy_item.shipment_item_purpose, 'unclassified') AS shipment_item_purpose
    FROM inventory.inventory_transactions AS inventory_tx
    LEFT JOIN wms.physical_shipment_items AS physical_item
      ON physical_item.legacy_wms_shipment_item_id = inventory_tx.shipment_item_id
    LEFT JOIN wms.outbound_shipment_items AS legacy_item
      ON legacy_item.id = inventory_tx.shipment_item_id
    LEFT JOIN wms.order_items AS original_order_item
      ON original_order_item.id = legacy_item.order_item_id
    LEFT JOIN wms.order_items AS replacement_order_item
      ON replacement_order_item.id = legacy_item.replacement_for_order_item_id
    LEFT JOIN catalog.product_variants AS ledger_sku_variant
      ON ledger_sku_variant.is_active = true
     AND UPPER(ledger_sku_variant.sku) = UPPER(
       COALESCE(original_order_item.sku, replacement_order_item.sku)
     )
    LEFT JOIN wms.outbound_shipments AS legacy_shipment
      ON legacy_shipment.id = legacy_item.shipment_id
    LEFT JOIN wms.orders AS target_order ON target_order.id = legacy_shipment.order_id
    LEFT JOIN warehouse.warehouse_locations AS source_location
      ON source_location.id = inventory_tx.from_location_id
    WHERE inventory_tx.transaction_type = 'ship'
      AND inventory_tx.voided_at IS NULL
      AND inventory_tx.variant_qty_delta < 0
      AND inventory_tx.created_at >= ${windowStartedAt}
      AND inventory_tx.created_at < ${windowEndedAt}
      AND physical_item.id IS NULL
      AND COALESCE(legacy_item.shipment_item_purpose, 'unclassified') <> 'omission_correction'
      AND (
        COALESCE(
          inventory_tx.product_variant_id,
          legacy_item.product_variant_id,
          ledger_sku_variant.id
        ) = ANY(${sqlIntegerArray(productVariantIds)})
        OR COALESCE(
          inventory_tx.product_variant_id,
          legacy_item.product_variant_id,
          ledger_sku_variant.id
        ) IS NULL
      )
    ORDER BY inventory_tx.id
  `));
  const buildRows = rows(await tx.execute(sql`
    SELECT
      consumption.id,
      consumption.build_run_id,
      component.component_variant_id AS product_variant_id,
      location.warehouse_id,
      consumption.qty,
      COALESCE(run.posted_at, run.created_at) AS occurred_at,
      run.posted_at IS NULL AS posted_at_missing
    FROM inventory.build_run_consumptions AS consumption
    JOIN inventory.build_runs AS run ON run.id = consumption.build_run_id
    JOIN inventory.build_order_components AS component
      ON component.id = consumption.build_order_component_id
    JOIN inventory.inventory_lots AS lot ON lot.id = consumption.inventory_lot_id
    LEFT JOIN warehouse.warehouse_locations AS location
      ON location.id = lot.warehouse_location_id
    WHERE run.status = 'posted'
      AND COALESCE(run.posted_at, run.created_at) >= ${windowStartedAt}
      AND COALESCE(run.posted_at, run.created_at) < ${windowEndedAt}
      AND component.component_variant_id = ANY(${sqlIntegerArray(productVariantIds)})
    ORDER BY consumption.id
  `));

  return [
    ...physicalRows.map((row): DemandConsumptionEvent => {
      const reasons: string[] = [];
      if (String(row.shipment_item_purpose) === "unclassified") {
        reasons.push(DEMAND_TRUST_REASON.unclassifiedPurpose);
      }
      if (String(row.shipment_status) === "review") {
        reasons.push(DEMAND_TRUST_REASON.shipmentReview);
      }
      if (String(row.inventory_source_type) === "internal" && row.ship_ledger_id == null) {
        reasons.push(DEMAND_TRUST_REASON.missingShipLedger);
      }
      return {
        eventKey: `physical-shipment-item:${String(row.id)}`,
        sourceKey: `physical-shipment:${String(row.physical_shipment_id)}`,
        sourceType: "physical_shipment",
        productVariantId: nullablePositiveInteger(row.product_variant_id, "physical.productVariantId"),
        warehouseId: nullablePositiveInteger(row.warehouse_id, "physical.warehouseId"),
        occurredAt: date(row.occurred_at, "physical.occurredAt"),
        quantityUnits: nonnegativeBigint(row.quantity_shipped, "physical.quantityShipped"),
        purpose: String(row.shipment_item_purpose),
        trustReasons: reasons,
      };
    }),
    ...ledgerGapRows.map((row): DemandConsumptionEvent => ({
      eventKey: `ship-ledger:${String(row.id)}`,
      sourceKey: `ship-ledger-item:${String(row.shipment_item_id ?? row.id)}`,
      sourceType: "ship_ledger_gap",
      productVariantId: nullablePositiveInteger(row.product_variant_id, "shipLedger.productVariantId"),
      warehouseId: nullablePositiveInteger(row.warehouse_id, "shipLedger.warehouseId"),
      occurredAt: date(row.occurred_at, "shipLedger.occurredAt"),
      quantityUnits: nonnegativeBigint(row.quantity_shipped, "shipLedger.quantityShipped"),
      purpose: String(row.shipment_item_purpose),
      trustReasons: [
        DEMAND_TRUST_REASON.missingPhysicalShipment,
        ...(String(row.shipment_item_purpose) === "unclassified"
          ? [DEMAND_TRUST_REASON.unclassifiedPurpose]
          : []),
      ],
    })),
    ...buildRows.map((row): DemandConsumptionEvent => ({
      eventKey: `build-consumption:${String(row.id)}`,
      sourceKey: `build-run:${String(row.build_run_id)}`,
      sourceType: "build_component",
      productVariantId: nullablePositiveInteger(row.product_variant_id, "build.productVariantId"),
      warehouseId: nullablePositiveInteger(row.warehouse_id, "build.warehouseId"),
      occurredAt: date(row.occurred_at, "build.occurredAt"),
      quantityUnits: nonnegativeBigint(row.qty, "build.quantity"),
      purpose: "build_component_consumption",
      trustReasons: Boolean(row.posted_at_missing) ? ["BUILD_POSTED_AT_MISSING"] : [],
    })),
  ];
}

function mapPolicyHeads(policyRows: Record<string, any>[]): PromiseSafetyPolicyHeadAdmin[] {
  const heads = new Map<string, PromiseSafetyPolicyHeadAdmin>();
  for (const row of policyRows) {
    const scopeKey = String(row.scope_key);
    const current = heads.get(scopeKey) ?? {
      scopeKey,
      revision: String(row.revision),
      activePolicy: null,
      draftPolicy: null,
    };
    const policy = mapPolicy(row);
    if (String(row.pointer_type) === "active") current.activePolicy = policy;
    if (String(row.pointer_type) === "draft") current.draftPolicy = policy;
    heads.set(scopeKey, current);
  }
  return [...heads.values()].sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
}

function mapPolicy(row: Record<string, any>): PromiseSafetyPolicyVersionAdmin {
  const scope = policyScope(row);
  const value = policyValue(row);
  return {
    policyId: positiveInteger(row.policy_id, "policy.id"),
    version: positiveInteger(row.version, "policy.version"),
    lifecycleStatus: String(row.lifecycle_status) as PromiseSafetyPolicyVersionAdmin["lifecycleStatus"],
    scope,
    value,
    definitionHash: String(row.definition_hash),
    changeReason: String(row.change_reason),
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at, "policy.createdAt"),
    updatedAt: iso(row.updated_at, "policy.updatedAt"),
  };
}

function policyScope(row: Record<string, any>): PromiseSafetyAdminScope {
  if (row.scope_type === "business") return { scopeType: "business" };
  if (row.scope_type === "network_variant") {
    return {
      scopeType: "network_variant",
      productVariantId: positiveInteger(row.product_variant_id, "policy.productVariantId"),
    };
  }
  return {
    scopeType: "warehouse_variant",
    warehouseId: positiveInteger(row.warehouse_id, "policy.warehouseId"),
    productVariantId: positiveInteger(row.product_variant_id, "policy.productVariantId"),
  };
}

function policyValue(row: Record<string, any>): PromiseSafetyAdminValue {
  if (row.policy_mode === "inherit") return { policyMode: "inherit" };
  if (row.policy_mode === "off") return { policyMode: "off" };
  if (row.policy_mode === "fixed_units") {
    return {
      policyMode: "fixed_units",
      fixedUnits: nonnegativeInteger(row.fixed_units, "policy.fixedUnits"),
    };
  }
  return {
    policyMode: "days_of_cover",
    daysOfCoverMilliDays: positiveInteger(
      row.days_of_cover_milli_days,
      "policy.daysOfCoverMilliDays",
    ),
    untrustedDemandFallbackUnits: nonnegativeInteger(
      row.untrusted_demand_fallback_units,
      "policy.untrustedDemandFallbackUnits",
    ),
    demandMethodVersion: String(row.demand_method_version),
  };
}

async function loadRefreshReplay(
  tx: Transaction,
  receiptKey: string,
  requestHash: string,
): Promise<RefreshDemandEvidenceAdminResult | null> {
  const [receipt] = await tx.select({
    requestHash: idempotencyKeys.requestHash,
    responseBody: idempotencyKeys.responseBody,
  }).from(idempotencyKeys).where(eq(idempotencyKeys.key, receiptKey)).limit(1);
  if (!receipt) return null;
  if (receipt.requestHash !== requestHash) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_AVAILABILITY_IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used with different demand-evidence inputs.",
    );
  }
  const body = receipt.responseBody as Record<string, unknown> | null;
  const parsed = refreshDemandEvidenceAdminResultSchema.safeParse(body?.result);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_DEMAND_EVIDENCE_INCOMPLETE_REPLAY",
      "The previous demand-evidence refresh did not record a complete result.",
    );
  }
  return { ...parsed.data, alreadyApplied: true };
}

async function loadPolicyUpdateReplay(
  tx: Transaction,
  receiptKey: string,
  requestHash: string,
) {
  const [receipt] = await tx.select({
    requestHash: idempotencyKeys.requestHash,
    responseBody: idempotencyKeys.responseBody,
  }).from(idempotencyKeys).where(eq(idempotencyKeys.key, receiptKey)).limit(1);
  if (!receipt) return null;
  if (receipt.requestHash !== requestHash) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_AVAILABILITY_IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used with different promise-safety inputs.",
    );
  }
  const body = receipt.responseBody as Record<string, unknown> | null;
  const result = body?.result as Record<string, unknown> | null;
  if (
    body?.commandType !== "promise_safety_policy_draft_update"
    || !result
    || !Number.isInteger(Number(result.policyId))
    || !Number.isInteger(Number(result.version))
    || typeof result.scopeKey !== "string"
    || !/^[0-9a-f]{64}$/.test(String(result.definitionHash))
  ) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "INVENTORY_AVAILABILITY_IDEMPOTENCY_RECEIPT_INVALID",
      "The promise-safety draft edit receipt is incomplete or malformed.",
    );
  }
  return {
    policyId: Number(result.policyId),
    version: Number(result.version),
    scopeKey: result.scopeKey,
    definitionHash: String(result.definitionHash),
    alreadyApplied: true,
  };
}

async function assertPolicyUpdateKeyIsUnique(
  tx: Transaction,
  idempotencyKey: string,
): Promise<void> {
  const receiptKey = `${POLICY_UPDATE_RECEIPT_PREFIX}${idempotencyKey}`;
  const usedRows = rows(await tx.execute(sql`
    SELECT 1
    FROM (
      SELECT idempotency_key FROM inventory.transformation_model_versions
      UNION ALL
      SELECT idempotency_key FROM inventory.location_promise_policy_versions
      UNION ALL
      SELECT idempotency_key FROM inventory.promise_safety_policy_versions
      UNION ALL
      SELECT substr(key, char_length('inventory-availability:') + 1) AS idempotency_key
      FROM public.idempotency_keys
      WHERE key LIKE 'inventory-availability:%'
      UNION ALL
      SELECT substr(key, char_length('inventory-promise-safety-update:') + 1) AS idempotency_key
      FROM public.idempotency_keys
      WHERE key LIKE 'inventory-promise-safety-update:%'
      UNION ALL
      SELECT substr(key, char_length('inventory-demand-evidence:') + 1) AS idempotency_key
      FROM public.idempotency_keys
      WHERE key LIKE 'inventory-demand-evidence:%'
    ) AS used_key
    WHERE used_key.idempotency_key = ${idempotencyKey}
      AND NOT EXISTS (
        SELECT 1 FROM public.idempotency_keys WHERE key = ${receiptKey}
      )
    LIMIT 1
  `));
  if (usedRows.length > 0) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used for a different master-data command.",
    );
  }
}

async function assertDemandRefreshKeyIsUnique(
  tx: Transaction,
  idempotencyKey: string,
): Promise<void> {
  const usedRows = rows(await tx.execute(sql`
    SELECT 1
    FROM (
      SELECT idempotency_key FROM inventory.transformation_model_versions
      UNION ALL
      SELECT idempotency_key FROM inventory.location_promise_policy_versions
      UNION ALL
      SELECT idempotency_key FROM inventory.promise_safety_policy_versions
      UNION ALL
      SELECT substr(key, char_length('inventory-availability:') + 1) AS idempotency_key
      FROM public.idempotency_keys
      WHERE key LIKE 'inventory-availability:%'
      UNION ALL
      SELECT substr(key, char_length('inventory-promise-safety-update:') + 1) AS idempotency_key
      FROM public.idempotency_keys
      WHERE key LIKE 'inventory-promise-safety-update:%'
      UNION ALL
      SELECT substr(key, char_length('inventory-demand-evidence:') + 1) AS idempotency_key
      FROM public.idempotency_keys
      WHERE key LIKE 'inventory-demand-evidence:%'
    ) AS used_key
    WHERE used_key.idempotency_key = ${idempotencyKey}
    LIMIT 1
  `));
  if (usedRows.length > 0) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used for a different master-data command.",
    );
  }
}

function stalePolicyDraft(): InventoryAvailabilityMasterDataError {
  return new InventoryAvailabilityMasterDataError(
    409,
    "INVENTORY_PROMISE_SAFETY_STALE_DRAFT",
    "The promise-safety draft changed. Reload it before saving.",
  );
}

function safetyPolicyColumns(value: PromiseSafetyAdminValue) {
  switch (value.policyMode) {
    case "inherit":
    case "off":
      return {
        policyMode: value.policyMode,
        fixedUnits: null,
        daysOfCoverMilliDays: null,
        untrustedDemandFallbackUnits: null,
        demandMethodVersion: null,
      };
    case "fixed_units":
      return {
        policyMode: value.policyMode,
        fixedUnits: value.fixedUnits,
        daysOfCoverMilliDays: null,
        untrustedDemandFallbackUnits: null,
        demandMethodVersion: null,
      };
    case "days_of_cover":
      return {
        policyMode: value.policyMode,
        fixedUnits: null,
        daysOfCoverMilliDays: value.daysOfCoverMilliDays,
        untrustedDemandFallbackUnits: value.untrustedDemandFallbackUnits,
        demandMethodVersion: value.demandMethodVersion,
      };
  }
}

function demandMethodContract() {
  return {
    methodVersion: INVENTORY_DEMAND_METHOD_VERSION,
    observationDays: INVENTORY_DEMAND_OBSERVATION_DAYS,
    minimumObservedDays: INVENTORY_DEMAND_MIN_OBSERVED_DAYS,
    minimumSourceEvents: INVENTORY_DEMAND_MIN_SOURCE_EVENTS,
    minimumActiveDays: INVENTORY_DEMAND_MIN_ACTIVE_DAYS,
    minimumConsumptionUnits: INVENTORY_DEMAND_MIN_CONSUMPTION_UNITS,
    recencyDays: INVENTORY_DEMAND_RECENCY_DAYS,
    maximumEvidenceAgeHours: INVENTORY_DEMAND_EVIDENCE_MAX_AGE_HOURS,
  } as const;
}

function rows(result: unknown): Record<string, any>[] {
  if (Array.isArray(result)) return result as Record<string, any>[];
  if (result && typeof result === "object" && "rows" in result) {
    return ((result as { rows?: unknown }).rows ?? []) as Record<string, any>[];
  }
  return [];
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "INVENTORY_PROMISE_SAFETY_INVALID_DATABASE_VALUE",
      `Inventory promise-safety ${field} is invalid.`,
    );
  }
  return parsed;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "INVENTORY_PROMISE_SAFETY_INVALID_DATABASE_VALUE",
      `Inventory promise-safety ${field} is invalid.`,
    );
  }
  return parsed;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value == null ? null : positiveInteger(value, field);
}

function nonnegativeBigint(value: unknown, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed < BigInt(0)) throw new Error("negative");
    return parsed;
  } catch {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "INVENTORY_PROMISE_SAFETY_INVALID_DATABASE_VALUE",
      `Inventory demand ${field} is invalid.`,
    );
  }
}

function nullableText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function iso(value: unknown, field: string): string {
  return date(value, field).toISOString();
}

function date(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "INVENTORY_PROMISE_SAFETY_INVALID_DATABASE_VALUE",
      `Inventory promise-safety ${field} is invalid.`,
    );
  }
  return parsed;
}

function laterDate(left: Date, right: Date): Date {
  return left >= right ? left : right;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}
