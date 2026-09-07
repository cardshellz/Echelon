import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { type CostComponent, type CostIssue } from "@shared/procurement/cost-source-contracts";
import { projectCostForFrozenLot, replaceCostComponent } from "../domain/cost-application.domain";
import { CostEvidenceError, costFingerprint, costInteger, lockInventoryCostGraph, type CostEvidenceTransaction, type RecordedCostRevision } from "../infrastructure/cost-evidence.repository";

const MAX_APPLICATION_LOTS = 10_000;
const MAX_APPLICATION_EDGES = 100_000;
const componentColumn = { product: "po_unit_cost_mills", packaging: "packaging_cost_mills", landed: "landed_cost_mills" } as const;
type Lot = { id: number; productMills: number; packagingMills: number; landedMills: number; qtyReceived: number; source: Record<string, any> };
type Projection = { lot: Lot; unitMills: number; remainderMills: number; allocatedMills: number; quantity: number };
export interface CostRevisionApplicationResult {
  applicationId: number;
  status: "applied" | "review_required";
  lotsUpdated: number;
  cogsRowsUpdated: number;
  totalCogsDeltaCents: number;
  issues: CostIssue[];
  replayed: boolean;
}
export interface CostComponentWriter {
  revalueComponent(lotId: number, component: CostComponent, unitMills: number, reason: string, tx: CostEvidenceTransaction): Promise<{ cogsRowsUpdated: number; totalCogsDeltaCents: number } | null>;
}

/** One inventory owner applies a source revision through the recorded graph.
 * It owns no physical balances. Missing roots, source intervals or descendants
 * are a durable review result; partial applications are never called complete. */
export async function applyCostRevision(
  tx: CostEvidenceTransaction, revision: RecordedCostRevision, writer: CostComponentWriter, actorId: string, now: Date,
): Promise<CostRevisionApplicationResult> {
  if (!actorId?.trim() || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new CostEvidenceError("COST_AUDIT_IDENTITY_REQUIRED", "Cost application requires an actor and valid clock.");
  await lockInventoryCostGraph(tx);
  const source = revision.contract;
  const shipmentLineId = source.scope.kind === "shipment_line" ? source.scope.inboundShipmentLineId : null;
  const rootsResult = await tx.execute(sql`
    SELECT origin.*, line.cost_source_kind, line.cost_source_evidence,
      EXISTS(SELECT 1 FROM procurement.receipt_reversals reversal WHERE reversal.receiving_line_id = origin.receiving_line_id) AS has_reversal
    FROM inventory.lot_cost_origins origin
    JOIN procurement.receiving_lines line ON line.id = origin.receiving_line_id
    WHERE origin.purchase_order_line_id = ${source.scope.purchaseOrderLineId}
      AND (${shipmentLineId}::integer IS NULL OR origin.inbound_shipment_line_id = ${shipmentLineId})
    ORDER BY origin.inventory_lot_id LIMIT ${MAX_APPLICATION_LOTS + 1}
  `);
  const roots = rootsResult.rows;
  const rootIds = roots.map((root) => costInteger(root.inventory_lot_id, "root.inventoryLotId", 1));
  const issues: CostIssue[] = [];
  if (source.evidence === "unknown" || source.evidence === "review_required") issues.push(source.issue!);
  if (source.currency !== "USD") issues.push({ code: "COST_CURRENCY_REVIEW", message: "The current inventory posting owner requires explicit USD source evidence." });
  if (source.totalMills === null || source.basePieces === null || source.totalMills < 0) issues.push({ code: "COST_SOURCE_NOT_APPLICABLE", message: "The source needs an explicit amount, quantity basis and supported signed-credit disposition." });
  if (roots.length > MAX_APPLICATION_LOTS) issues.push({ code: "COST_APPLICATION_LIMIT", message: "The complete cost graph exceeds the application limit; plan a bounded reviewed application." });
  if (roots.some((root) => root.cost_source_kind !== "purchase_order_line" || root.has_reversal)) issues.push({ code: "COST_ROOT_REVIEW_REQUIRED", message: "A receipt has unproven price provenance or a recorded reversal; review its contribution before revaluing inventory." });
  const unknownRoots = await tx.execute(sql`
    SELECT lot.id FROM inventory.inventory_lots lot
    WHERE lot.po_line_id = ${source.scope.purchaseOrderLineId}
      AND (${shipmentLineId}::integer IS NULL OR lot.inbound_shipment_id = ${source.scope.kind === "shipment_line" ? source.scope.inboundShipmentId : null})
      AND NOT EXISTS(SELECT 1 FROM inventory.lot_cost_origins origin WHERE origin.inventory_lot_id = lot.id)
      AND NOT EXISTS(SELECT 1 FROM inventory.lot_cost_contributions edge WHERE edge.output_lot_id = lot.id)
    ORDER BY lot.id LIMIT 1
  `);
  if (unknownRoots.rows.length > 0) issues.push({ code: "COST_HISTORICAL_LINEAGE_MISSING", message: `Inventory lot ${unknownRoots.rows[0].id} lacks an immutable receipt or transformation source.` });
  const graph = rootIds.length === 0 ? { rows: [] } : await tx.execute(sql`
    WITH RECURSIVE descendants(id) AS (
      SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(rootIds)}::jsonb)
      UNION SELECT edge.output_lot_id FROM inventory.lot_cost_contributions edge JOIN descendants d ON edge.source_lot_id = d.id
    ) SELECT id FROM descendants ORDER BY id LIMIT ${MAX_APPLICATION_LOTS + 1}
  `);
  const lotIds = graph.rows.map((row) => costInteger(row.id, "graph.lotId", 1));
  if (lotIds.length > MAX_APPLICATION_LOTS) issues.push({ code: "COST_APPLICATION_LIMIT", message: "The complete cost graph exceeds the application limit." });
  const edgeResult = lotIds.length === 0 ? { rows: [] } : await tx.execute(sql`
    SELECT edge.* FROM inventory.lot_cost_contributions edge
    WHERE edge.output_lot_id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(lotIds)}::jsonb)) ORDER BY edge.id LIMIT ${MAX_APPLICATION_EDGES + 1}
  `);
  if (edgeResult.rows.length > MAX_APPLICATION_EDGES) issues.push({ code: "COST_APPLICATION_LIMIT", message: "The complete cost contribution set exceeds the application limit." });
  const edgesByOutput = new Map<number, any[]>();
  for (const edge of edgeResult.rows) {
    const outputId = costInteger(edge.output_lot_id, "outputLotId", 1);
    const inputs = edgesByOutput.get(outputId) ?? []; inputs.push(edge); edgesByOutput.set(outputId, inputs);
  }
  const allLotIds = [...new Set([...lotIds, ...edgeResult.rows.map((edge) => costInteger(edge.source_lot_id, "sourceLotId", 1))])].sort((a,b) => a-b);
  const lotResult = allLotIds.length === 0 ? { rows: [] } : await tx.execute(sql`
    SELECT id,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,qty_received,cost_source,
      EXISTS(SELECT 1 FROM inventory.cost_component_protections protection WHERE protection.inventory_lot_id=inventory_lots.id AND protection.component=${source.component}) AS component_protected
    FROM inventory.inventory_lots
    WHERE id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(allLotIds)}::jsonb))
    ORDER BY id FOR UPDATE
  `);
  const lots = new Map<number, Lot>(lotResult.rows.map((row) => [costInteger(row.id, "lot.id", 1), {
    id: costInteger(row.id, "lot.id", 1), productMills: costInteger(row.po_unit_cost_mills, "productMills"),
    packagingMills: costInteger(row.packaging_cost_mills, "packagingMills"), landedMills: costInteger(row.landed_cost_mills, "landedMills"),
    qtyReceived: costInteger(row.qty_received, "qtyReceived", 1), source: row,
  }]));
  if (lots.size !== allLotIds.length) issues.push({ code: "COST_GRAPH_LOT_MISSING", message: "A recorded contribution refers to a missing inventory lot." });
  if (lotIds.some((id) => { const lot = lots.get(id); return lot?.source.component_protected || (source.component === "product" && lot?.source.cost_source === "manual"); })) {
    issues.push({ code: "COST_MANUAL_OVERRIDE_REVIEW", message: "A manual correction protects this component. Review its disposition before a source revision may replace it; unrelated components remain independent." });
  }
  const projections = new Map<number, Projection>();
  if (issues.length === 0 && source.totalMills !== null && source.basePieces !== null) {
    for (const root of roots) {
      const lot = lots.get(Number(root.inventory_lot_id))!;
      try {
        const projection = projectCostForFrozenLot({ totalMills: source.totalMills, basePieces: source.basePieces,
          startBasePiece: costInteger(shipmentLineId === null ? root.purchase_start_base_piece : root.shipment_start_base_piece, "startBasePiece"),
          lotQuantity: costInteger(root.received_variant_qty, "receivedVariantQty", 1), unitsPerVariantSnapshot: costInteger(root.units_per_variant_snapshot, "unitsPerVariantSnapshot", 1) });
        projections.set(lot.id, { lot, unitMills: projection.unitMills, remainderMills: projection.remainderMills, allocatedMills: projection.allocatedMills, quantity: projection.lotQuantity });
      } catch (error) {
        issues.push({ code: "COST_SOURCE_INTERVAL_REVIEW", message: `Lot ${lot.id} is outside the captured source quantity: ${error instanceof Error ? error.message : "invalid interval"}` });
      }
    }
    const pending = new Set(lotIds.filter((id) => !projections.has(id)));
    while (pending.size > 0 && issues.length === 0) {
      let advanced = false;
      for (const id of pending) {
        const inputs = edgesByOutput.get(id) ?? [];
        if (inputs.length === 0 || inputs.some((edge) => pending.has(Number(edge.source_lot_id)))) continue;
        const denominators = new Set(inputs.map((edge) => costInteger(edge.output_qty, "outputQty", 1)));
        const offsets = new Set(inputs.map((edge) => costInteger(edge.output_start_qty, "outputStartQty")));
        const operations = new Set(inputs.map((edge) => String(edge.operation_key)));
        if (denominators.size !== 1 || offsets.size !== 1 || operations.size !== 1) {
          issues.push({ code: "COST_CONTRIBUTION_DENOMINATOR_CONFLICT", message: `Output lot ${id} has inconsistent conversion intervals.` }); break;
        }
        let inputTotal = BigInt(0);
        for (const edge of inputs) {
          const parentId = costInteger(edge.source_lot_id, "sourceLotId", 1);
          const parent = lots.get(parentId)!;
          const parentProjection = projections.get(parentId);
          const sourceQty = costInteger(edge.source_qty, "sourceQty", 1);
          if (sourceQty > parent.qtyReceived || parentProjection?.remainderMills) {
            issues.push({ code: "COST_TRANSFORM_RESIDUAL_REVIEW", message: `Lot ${parentId} has an unproven source interval or uniform-cost residual.` }); break;
          }
          const parentCost = parentProjection?.unitMills ?? costInteger(parent.source[componentColumn[source.component]], "parentCost");
          inputTotal += BigInt(parentCost) * BigInt(sourceQty);
        }
        if (issues.length > 0) break;
        const lot = lots.get(id)!;
        try {
          // Every output layer owns its immutable interval of the COMPLETE
          // operation. Cumulative allocation conserves a 7-mill input split
          // into three one-unit lots as 2 + 2 + 3, never 2 + 2 + 2.
          const projected = projectCostForFrozenLot({ totalMills: costInteger(inputTotal.toString(), "conversionTotalMills"),
            basePieces: [...denominators][0], startBasePiece: [...offsets][0], lotQuantity: lot.qtyReceived, unitsPerVariantSnapshot: 1 });
          projections.set(id, { lot, unitMills: projected.unitMills, allocatedMills: projected.allocatedMills,
            quantity: lot.qtyReceived, remainderMills: projected.remainderMills });
        } catch (error) {
          issues.push({ code: "COST_TRANSFORM_INTERVAL_REVIEW", message: `Output lot ${id} cannot represent the captured cost interval: ${error instanceof Error ? error.message : "invalid interval"}` }); break;
        }
        pending.delete(id); advanced = true;
      }
      if (!advanced) issues.push({ code: "COST_GRAPH_INCOMPLETE", message: "The cost contribution graph is cyclic or missing a parent." });
    }
  }
  const targets = [...projections.values()].sort((a,b) => a.lot.id-b.lot.id);
  if (targets.some((target) => target.remainderMills !== 0)) {
    issues.push({ code: "COST_UNIFORM_LOT_RESIDUAL_REVIEW", message: "This source cannot be represented exactly by the existing uniform lot cost. Its exact remainder is preserved for review; no partial revaluation was posted." });
  }
  const identity = { sourceRevisionId: revision.id, lotIds, graph: edgeResult.rows, issues,
    targets: targets.map((target) => ({ id: target.lot.id, unitMills: target.unitMills, remainderMills: target.remainderMills })) };
  const planFingerprint = costFingerprint(identity);
  const replay = await tx.execute(sql`SELECT id,status,evidence FROM inventory.cost_applications WHERE source_revision_id = ${revision.id} ORDER BY id DESC LIMIT 1`);
  const currentComponentsMatch = targets.every((target) => Number(target.lot.source[componentColumn[source.component]]) === target.unitMills);
  if (replay.rows[0]?.evidence.planFingerprint === planFingerprint && (issues.length > 0 || currentComponentsMatch)) {
    return { ...replay.rows[0].evidence.result, applicationId: costInteger(replay.rows[0].id, "applicationId", 1), replayed: true };
  }
  const applicationKey = costFingerprint({ planFingerprint, priorApplicationId: replay.rows[0]?.id ?? null });
  const result: CostRevisionApplicationResult = { applicationId: 0, status: issues.length > 0 ? "review_required" : "applied", lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0, issues, replayed: false };
  const changes: Array<{ lotId: number; before: unknown; after: unknown }> = [];
  if (issues.length === 0) {
    for (const target of targets) {
      const { lot } = target;
      const before = { productMills: lot.productMills, packagingMills: lot.packagingMills, landedMills: lot.landedMills };
      const after = replaceCostComponent({ current: before, component: source.component, unitMills: target.unitMills });
      if (after.totalMills < 0) throw new CostEvidenceError("COST_NEGATIVE_LOT", "The current lot owner cannot represent a negative total.", { lotId: lot.id });
      const revalue = await writer.revalueComponent(lot.id, source.component, target.unitMills, `source_revision:${revision.id}`, tx);
      if (!revalue) throw new CostEvidenceError("COST_LOT_DISAPPEARED", "A locked cost application lot was not updated.", { lotId: lot.id });
      result.lotsUpdated++;
      result.cogsRowsUpdated = costInteger((BigInt(result.cogsRowsUpdated) + BigInt(costInteger(revalue.cogsRowsUpdated, "cogsRowsUpdated"))).toString(), "cogsRowsUpdated");
      result.totalCogsDeltaCents = costInteger((BigInt(result.totalCogsDeltaCents) + BigInt(costInteger(revalue.totalCogsDeltaCents, "totalCogsDeltaCents", -Number.MAX_SAFE_INTEGER))).toString(), "totalCogsDeltaCents", -Number.MAX_SAFE_INTEGER);
      changes.push({ lotId: lot.id, before, after: { ...after, component: source.component, allocatedMills: target.allocatedMills, quantity: target.quantity, remainderMills: target.remainderMills } });
    }
  }
  const application = await tx.execute(sql`
    INSERT INTO inventory.cost_applications(application_key,source_revision_id,status,evidence,recorded_by,recorded_at)
    VALUES (${applicationKey},${revision.id},${result.status},${canonicalJson({ ...identity, planFingerprint, result })}::jsonb,${actorId},${now}) RETURNING id
  `);
  result.applicationId = costInteger(application.rows[0]?.id, "applicationId", 1);
  for (const change of changes) await tx.execute(sql`
    INSERT INTO inventory.cost_application_lots(application_id,inventory_lot_id,before_state,after_state)
    VALUES (${result.applicationId},${change.lotId},${canonicalJson(change.before)}::jsonb,${canonicalJson(change.after)}::jsonb)
  `);
  if (result.status === "applied") await tx.execute(sql`
    INSERT INTO inventory.cost_reporting_events(application_id,contract_version,payload,recorded_at)
    VALUES (${result.applicationId},1,${canonicalJson({ contractVersion: 1, currency: source.currency, sourceRevisionId: revision.id, sourceFingerprint: source.fingerprint, component: source.component, changes, cogsDeltaCents: result.totalCogsDeltaCents, actorId, recordedAt: now.toISOString() })}::jsonb,${now})
  `);
  return result;
}
