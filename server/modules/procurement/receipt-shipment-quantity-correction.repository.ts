import { and, eq, sql } from "drizzle-orm";
import {
  poExceptions,
  poStatusHistory,
  inboundShipmentStatusHistory,
} from "@shared/schema/procurement.schema";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  quantityCorrectionHistorySchema,
  type QuantityCorrectionInput,
  type QuantityCorrectionSummary,
  type QuantityCorrectionPurpose,
} from "@shared/procurement/receipt-shipment-quantity-correction";
import { readPurchaseApprovalActor } from "../identity/infrastructure/purchase-approval-access.repository";
import {
  costFingerprint,
  costInteger,
  lockInventoryCostGraph,
} from "../inventory/infrastructure/cost-evidence.repository";
import { readOriginRepairGraphEvidence } from "./cost-origin-repair.repository";
import { recordCostOriginAmendment } from "../inventory/infrastructure/cost-origin-amendment.repository";
import { readPurchaseCostSource } from "./purchase-cost-source.repository";
import {
  correctedReceiptLifecycle,
  correctionInteger as integer,
  QuantityCorrectionError,
  type QuantityCorrectionFacts,
  type QuantityCorrectionPlan,
} from "./domain/receipt-shipment-quantity-correction";
import { receivingLineStatus } from "./domain/receiving-line-status";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";

type Row = Record<string, unknown>;
const LIMIT = 200;
function bounded(rows: Row[], name: string): Row[] {
  if (rows.length > LIMIT)
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_LIMIT",
      `The ${name} exceed the review limit. No partial correction is allowed.`,
    );
  return rows;
}
export async function resolveReceiptShipmentLine(
  tx: AmendmentTransaction,
  receiptLineId: number,
): Promise<number> {
  const result =
    await tx.execute(sql`SELECT shipment_line.id FROM procurement.receiving_lines receipt_line
    JOIN procurement.receiving_orders receipt ON receipt.id=receipt_line.receiving_order_id
    JOIN procurement.inbound_shipment_lines shipment_line ON shipment_line.inbound_shipment_id=receipt.inbound_shipment_id
      AND shipment_line.purchase_order_line_id=receipt_line.purchase_order_line_id
      AND (receipt_line.inbound_shipment_line_id=shipment_line.id OR receipt_line.inbound_shipment_line_id IS NULL)
    WHERE receipt_line.id=${receiptLineId} ORDER BY shipment_line.id LIMIT 2`);
  if (result.rows.length !== 1)
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_LINK",
      "This receipt must identify one shipment line before its quantity can be corrected.",
    );
  return integer(result.rows[0].id, "shipment line", 1);
}
export async function readQuantityCorrectionOptions(
  tx: AmendmentTransaction,
  poId: number,
) {
  return bounded(
    (
      await tx.execute(sql`SELECT line.id AS "shipmentLineId", shipment.shipment_number AS "shipmentNumber",
    COALESCE(line.sku,'') AS sku,line.qty_shipped AS "shippedPieces"
    FROM procurement.inbound_shipment_lines line JOIN procurement.inbound_shipments shipment ON shipment.id=line.inbound_shipment_id
    WHERE line.purchase_order_id=${poId} AND shipment.status<>'cancelled'
      AND EXISTS(SELECT 1 FROM procurement.receiving_orders receipt WHERE receipt.inbound_shipment_id=shipment.id AND receipt.status='closed')
    ORDER BY shipment.id,line.id LIMIT ${LIMIT + 1}`)
    ).rows,
    "shipment lines",
  );
}
export async function readQuantityCorrectionSource(
  tx: AmendmentTransaction,
  lineId: number,
  actorId: string,
  purpose: QuantityCorrectionPurpose = "receipt",
) {
  await lockInventoryCostGraph(tx);
  const rows = (
    await tx.execute(sql`SELECT shipment.* FROM procurement.inbound_shipments shipment
    JOIN procurement.inbound_shipment_lines line ON line.inbound_shipment_id=shipment.id WHERE line.id=${lineId} FOR UPDATE OF shipment`)
  ).rows;
  if (!rows.length)
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_NOT_FOUND",
      "Shipment line not found.",
      404,
    );
  const shipment = rows[0] as Row;
  const shipmentLines = bounded(
    (
      await tx.execute(sql`SELECT * FROM procurement.inbound_shipment_lines
    WHERE inbound_shipment_id=${shipment.id} ORDER BY id FOR UPDATE`)
    ).rows,
    "shipment lines",
  );
  const target = shipmentLines.find((line) => line.id === lineId)!;
  if (!target.purchase_order_line_id || !target.purchase_order_id)
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_PO_LINK",
      "The shipment line needs its original purchase order link.",
    );
  const poId = integer(target.purchase_order_id, "purchase order", 1);
  const poLineId = integer(
    target.purchase_order_line_id,
    "purchase order line",
    1,
  );
  const po = (
    await tx.execute(
      sql`SELECT * FROM procurement.purchase_orders WHERE id=${poId} FOR UPDATE`,
    )
  ).rows[0] as Row;
  const poLines = bounded(
    (
      await tx.execute(
        sql`SELECT * FROM procurement.purchase_order_lines WHERE purchase_order_id=${poId} ORDER BY id FOR UPDATE`,
      )
    ).rows,
    "purchase lines",
  );
  const poLine = poLines.find((line) => line.id === poLineId);
  if (!po || !poLine)
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_PO_LINK",
      "The shipment's purchase order and line disagree.",
    );
  const relatedLines = bounded(
    (
      await tx.execute(sql`SELECT line.*,shipment.status AS shipment_status FROM procurement.inbound_shipment_lines line
    JOIN procurement.inbound_shipments shipment ON shipment.id=line.inbound_shipment_id WHERE line.purchase_order_line_id=${poLineId}
    ORDER BY line.id`)
    ).rows,
    "related shipment lines",
  );
  const receiptRows = bounded(
    (
      await tx.execute(sql`SELECT line.*,receipt.status AS receipt_status,receipt.receipt_number,
    receipt.purchase_order_id AS receipt_po_id FROM procurement.receiving_lines line
    JOIN procurement.receiving_orders receipt ON receipt.id=line.receiving_order_id
    WHERE receipt.inbound_shipment_id=${shipment.id} AND line.purchase_order_line_id=${poLineId}
      AND (line.inbound_shipment_line_id=${lineId} OR line.inbound_shipment_line_id IS NULL)
    ORDER BY line.receiving_order_id,line.id FOR UPDATE OF receipt,line`)
    ).rows,
    "receipts",
  );
  const postings = bounded(
    (
      await tx.execute(
        sql`SELECT * FROM procurement.po_receipts WHERE purchase_order_line_id=${poLineId} ORDER BY id FOR UPDATE`,
      )
    ).rows,
    "PO receipt postings",
  );
  const reversals = bounded(
    (
      await tx.execute(sql`SELECT reversal.* FROM procurement.receipt_reversals reversal
    JOIN procurement.receiving_lines line ON line.id=reversal.receiving_line_id
    WHERE line.purchase_order_line_id=${poLineId} ORDER BY reversal.id`)
    ).rows,
    "receipt reversals",
  );
  const origins = bounded(
    (
      await tx.execute(sql`SELECT * FROM inventory.effective_lot_cost_origins
    WHERE purchase_order_line_id=${poLineId} ORDER BY purchase_start_base_piece,inventory_lot_id`)
    ).rows,
    "receipt cost origins",
  );
  const costs = bounded(
    (
      await tx.execute(
        sql`SELECT * FROM procurement.inbound_freight_costs WHERE inbound_shipment_id=${shipment.id} ORDER BY id FOR UPDATE`,
      )
    ).rows,
    "shipment charges",
  );
  const snapshots = bounded(
    (
      await tx.execute(sql`SELECT snapshot.* FROM procurement.landed_cost_snapshots snapshot
    JOIN procurement.inbound_shipment_lines line ON line.id=snapshot.inbound_shipment_line_id
    WHERE line.inbound_shipment_id=${shipment.id} OR line.purchase_order_line_id=${poLineId} ORDER BY snapshot.id`)
    ).rows,
    "cost snapshots",
  );
  const affectedPoLineIds = [
    ...new Set([
      poLineId,
      ...shipmentLines
        .filter((line) => line.purchase_order_line_id != null)
        .map((line) =>
          integer(line.purchase_order_line_id, "affected PO line", 1),
        ),
    ]),
  ].sort((a, b) => a - b);
  const costEvidence = [];
  for (const id of affectedPoLineIds)
    costEvidence.push({
      id,
      source: await readPurchaseCostSource(tx, id),
      graph: await readOriginRepairGraphEvidence(tx, id),
      approvals: (
        await tx.execute(sql`SELECT * FROM inventory.cost_reconciliation_approvals
      WHERE purchase_order_line_id=${id} OR inbound_shipment_line_id IN (SELECT id FROM procurement.inbound_shipment_lines WHERE purchase_order_line_id=${id}) ORDER BY id`)
      ).rows,
      postings: (
        await tx.execute(sql`SELECT * FROM inventory.cost_reconciliation_postings
      WHERE purchase_order_line_id=${id} OR inbound_shipment_line_id IN (SELECT id FROM procurement.inbound_shipment_lines WHERE purchase_order_line_id=${id}) ORDER BY id`)
      ).rows,
    });
  const saved = (
    await tx.execute(sql`SELECT amendment.id,amendment.actor_name,amendment.approved_at,
      amendment.source_version,amendment.reason,result.summary FROM procurement.receipt_shipment_quantity_amendments amendment
    JOIN procurement.receipt_shipment_quantity_results result ON result.amendment_id=amendment.id
    WHERE amendment.inbound_shipment_line_id=${lineId} ORDER BY amendment.id DESC LIMIT 50`)
  ).rows;
  const history = saved.map((row) =>
    quantityCorrectionHistorySchema.parse({
      id: costInteger(row.id, "amendmentId", 1),
      approvedBy: row.actor_name,
      approvedAt: new Date(String(row.approved_at)).toISOString(),
      reason: row.reason,
      summary: row.summary,
      sourceVersion: row.source_version,
    }),
  );
  const actor = await readPurchaseApprovalActor(tx, actorId);
  const exceptions = await tx
    .select()
    .from(poExceptions)
    .where(
      and(eq(poExceptions.poId, poId), eq(poExceptions.kind, "match_mismatch")),
    );
  // Prior evidence already has its immutable owner. Do not recursively embed
  // earlier complete audits inside each new correction.
  const evidence = {
    shipment,
    shipmentLines,
    po,
    poLines,
    relatedLines,
    receiptRows,
    postings,
    reversals,
    origins,
    costs,
    snapshots,
    costEvidence,
    exceptions,
    history,
  };
  const sourceVersion = costFingerprint({
    contractVersion: 1,
    evidence,
    actor,
  });
  let blockedReason: string | null = null;
  if (costs.some((cost) => cost.currency !== "USD"))
    blockedReason =
      "Confirm the converted USD shipment charges before correcting their quantity and cost basis.";
  if (
    shipment.status === "cancelled" ||
    po.cancelled_at != null ||
    ["cancelled", "short_closed"].includes(String(po.status)) ||
    ["cancelled", "short_closed"].includes(String(po.physical_status)) ||
    poLine.status === "cancelled" ||
    Number(poLine.returned_qty ?? 0) !== 0
  )
    blockedReason =
      "Cancelled shipments, cancelled/short-closed POs, or returned purchase lines need their owning reversal workflow.";
  if (!receiptRows.length && purpose === "receipt")
    blockedReason =
      "No linked posted receipt was found. Use the normal shipment editor before receiving.";
  if (
    shipmentLines.filter((line) => line.purchase_order_line_id === poLineId)
      .length > 1 &&
    receiptRows.some((line) => line.inbound_shipment_line_id == null)
  )
    blockedReason =
      "A historical receipt could belong to more than one shipment line. Its source link must be resolved first.";
  const receipts: QuantityCorrectionFacts["receipts"] = [];
  const pendingReceipts: NonNullable<
    QuantityCorrectionFacts["pendingReceipts"]
  > = [];
  for (const line of receiptRows) {
    if (line.receipt_status === "cancelled") continue;
    if (purpose === "shipment" && line.receipt_status !== "closed") {
      if (
        line.units_per_variant_snapshot == null ||
        Number(line.receipt_po_id) !== poId ||
        Number(line.inbound_shipment_line_id) !== lineId ||
        Number(line.reversed_qty ?? 0) !== 0
      ) {
        blockedReason = `Review the source link and receiving unit on ${line.receipt_number} before editing the shipment.`;
        continue;
      }
      pendingReceipts.push({
        receiptId: integer(line.receiving_order_id, "receipt", 1),
        receiptLineId: integer(line.id, "receipt line", 1),
        receiptNumber: String(line.receipt_number),
        expectedUnits: integer(line.expected_qty, "expected receipt units"),
        receivedUnits: integer(line.received_qty, "received units"),
        piecesPerUnit: integer(
          line.units_per_variant_snapshot,
          "receipt unit",
          1,
        ),
      });
      continue;
    }
    if (
      line.receipt_status !== "closed" ||
      Number(line.reversed_qty ?? 0) !== 0 ||
      Number(line.damaged_qty ?? 0) !== 0 ||
      reversals.some((row) => row.receiving_line_id === line.id)
    ) {
      blockedReason =
        "Finish open receiving work and resolve damaged or reversed receipt quantities before correcting their piece conversion.";
      continue;
    }
    const posted = postings.filter((row) => row.receiving_line_id === line.id);
    const receivedUnits = integer(line.received_qty, "received units", 1);
    if (
      posted.length !== 1 ||
      Number(posted[0].receiving_order_id) !==
        Number(line.receiving_order_id) ||
      Number(posted[0].purchase_order_id) !== poId ||
      Number(line.receipt_po_id) !== poId
    ) {
      blockedReason =
        "The receipt needs one matching PO receipt posting before quantities can be amended.";
      continue;
    }
    const receivedPieces = integer(posted[0].qty_received, "posted pieces", 1);
    if (
      receivedPieces % receivedUnits !== 0 ||
      (line.units_per_variant_snapshot != null &&
        receivedPieces !==
          receivedUnits * Number(line.units_per_variant_snapshot))
    ) {
      blockedReason =
        "The saved receipt conversion and PO posting conflict. Resolve this existing posting inconsistency first.";
      continue;
    }
    receipts.push({
      id: integer(line.id, "receipt line", 1),
      receiptId: integer(line.receiving_order_id, "receipt", 1),
      receiptNumber: String(line.receipt_number),
      receivedUnits,
      receivedPieces,
      piecesPerUnit: receivedPieces / receivedUnits,
      unitWasRecorded: line.units_per_variant_snapshot != null,
      variantId: integer(line.product_variant_id, "receipt variant", 1),
    });
  }
  const facts: QuantityCorrectionFacts = {
    shipmentLineId: lineId,
    shippedPieces: integer(target.qty_shipped, "shipped pieces", 1),
    orderPieces: integer(poLine.order_qty, "ordered pieces", 1),
    poReceivedPieces: integer(poLine.received_qty, "PO received pieces"),
    cancelledPieces: integer(poLine.cancelled_qty ?? 0, "cancelled pieces"),
    otherShippedPieces: integer(
      relatedLines
        .filter(
          (line) => line.id !== lineId && line.shipment_status !== "cancelled",
        )
        .reduce(
          (sum, line) =>
            sum + BigInt(integer(line.qty_shipped, "other shipped pieces")),
          BigInt(0),
        )
        .toString(),
      "other shipped pieces",
    ),
    receipts,
    pendingReceipts,
    origins: origins.map((origin) => ({
      inventoryLotId: integer(origin.inventory_lot_id, "lot", 1),
      receiptLineId: integer(
        origin.receiving_line_id,
        "origin receipt line",
        1,
      ),
      shipmentLineId:
        origin.inbound_shipment_line_id == null
          ? null
          : integer(origin.inbound_shipment_line_id, "origin shipment line", 1),
      receivedUnits: integer(origin.received_variant_qty, "origin quantity", 1),
      piecesPerUnit: integer(
        origin.units_per_variant_snapshot,
        "origin unit",
        1,
      ),
      purchaseStart: integer(
        origin.purchase_start_base_piece,
        "purchase interval",
      ),
      shipmentStart:
        origin.shipment_start_base_piece == null
          ? null
          : integer(origin.shipment_start_base_piece, "shipment interval"),
    })),
  };
  return { evidence, facts, sourceVersion, actor, blockedReason, history };
}
export type QuantityCorrectionSource = Awaited<
  ReturnType<typeof readQuantityCorrectionSource>
>;

export async function persistQuantityCorrection(
  tx: AmendmentTransaction,
  source: QuantityCorrectionSource,
  plan: QuantityCorrectionPlan,
  input: QuantityCorrectionInput,
  actorId: string,
  actorName: string,
  now: Date,
  purpose: QuantityCorrectionPurpose = "receipt",
  physicalTotals?: {
    totalWeightKg: string;
    totalVolumeCbm: string;
    chargeableWeightKg: string;
  },
): Promise<number> {
  const { shipment, shipmentLines, po, poLines } = source.evidence;
  const line = shipmentLines.find(
    (row) => row.id === source.facts.shipmentLineId,
  )!;
  const poLine = poLines.find((row) => row.id === line.purchase_order_line_id)!;
  const audit =
    await tx.execute(sql`INSERT INTO procurement.receipt_shipment_quantity_amendments
    (inbound_shipment_line_id,purchase_order_line_id,source_version,actor_id,actor_name,reason,approved_at,evidence)
    VALUES(${line.id},${poLine.id},${source.sourceVersion},${actorId},${actorName},${input.reason},${now},
      ${canonicalJson({ contractVersion: 1, purpose, before: source.evidence, input, plan, authority: source.actor })}::jsonb) RETURNING id`);
  const amendmentId = costInteger(audit.rows[0]?.id, "amendmentId", 1);
  for (const receipt of purpose === "receipt" ? plan.receipts : []) {
    await tx.execute(sql`UPDATE procurement.receiving_lines SET units_per_variant_snapshot=${receipt.afterPiecesPerUnit},
      inbound_shipment_line_id=${line.id},updated_at=${now} WHERE id=${receipt.id}`);
    await tx.execute(sql`UPDATE procurement.receiving_orders SET updated_at=GREATEST(${now}::timestamp,updated_at+interval '1 millisecond')
      WHERE id=${receipt.receiptId}`);
    await tx.execute(sql`UPDATE procurement.po_receipts SET qty_received=${receipt.afterPieces}
      WHERE receiving_line_id=${receipt.id} AND purchase_order_line_id=${poLine.id}`);
  }
  for (const receipt of plan.pendingReceipts) {
    if (receipt.expectedUnits === receipt.afterExpectedUnits) continue;
    await tx.execute(sql`UPDATE procurement.receiving_lines SET expected_qty=${receipt.afterExpectedUnits},
      status=${receivingLineStatus(receipt.receivedUnits, receipt.afterExpectedUnits)},
      updated_at=GREATEST(${now}::timestamp,updated_at+interval '1 millisecond') WHERE id=${receipt.receiptLineId}`);
    const receiptLines = (
      await tx.execute(sql`SELECT expected_qty FROM procurement.receiving_lines
      WHERE receiving_order_id=${receipt.receiptId} ORDER BY id`)
    ).rows;
    const expectedTotal = integer(
      receiptLines
        .reduce(
          (sum, row) =>
            sum + BigInt(integer(row.expected_qty, "expected receipt units")),
          BigInt(0),
        )
        .toString(),
      "expected receipt total",
    );
    await tx.execute(sql`UPDATE procurement.receiving_orders SET expected_total_units=${expectedTotal},
      updated_at=GREATEST(${now}::timestamp,updated_at+interval '1 millisecond') WHERE id=${receipt.receiptId}`);
  }
  for (const origin of plan.origins) {
    const before = source.facts.origins.find(
      (row) => row.inventoryLotId === origin.inventoryLotId,
    )!;
    if (canonicalJson(before) === canonicalJson(origin)) continue;
    await recordCostOriginAmendment(tx, {
      amendmentId,
      inventoryLotId: origin.inventoryLotId,
      unitsPerVariantSnapshot: origin.piecesPerUnit,
      purchaseStartBasePiece: origin.purchaseStart,
      shipmentStartBasePiece: origin.shipmentStart,
    });
  }
  const uniform =
    plan.receipts.length > 0 &&
    plan.receipts.every(
      (receipt) =>
        receipt.variantId === plan.receipts[0].variantId &&
        receipt.afterPiecesPerUnit === plan.receipts[0].afterPiecesPerUnit,
    ) &&
    plan.shippedPieces % plan.receipts[0].afterPiecesPerUnit === 0;
  await tx.execute(sql`UPDATE procurement.inbound_shipment_lines SET qty_shipped=${plan.shippedPieces},
    product_variant_id=${purpose === "shipment" ? line.product_variant_id : uniform ? plan.receipts[0].variantId : null},
    units_per_variant_snapshot=${purpose === "shipment" ? line.units_per_variant_snapshot : uniform ? plan.receipts[0].afterPiecesPerUnit : null},
    total_weight_kg=${physicalTotals?.totalWeightKg ?? line.total_weight_kg},
    total_volume_cbm=${physicalTotals?.totalVolumeCbm ?? line.total_volume_cbm},
    chargeable_weight_kg=${physicalTotals?.chargeableWeightKg ?? line.chargeable_weight_kg},
    updated_at=GREATEST(${now}::timestamp,updated_at+interval '1 millisecond') WHERE id=${line.id}`);
  const totalPieces = shipmentLines.reduce(
    (sum, row) =>
      sum +
      BigInt(
        row.id === line.id
          ? plan.shippedPieces
          : integer(row.qty_shipped, "shipment pieces"),
      ),
    BigInt(0),
  );
  await tx.execute(sql`UPDATE procurement.inbound_shipments SET total_pieces=${integer(totalPieces.toString(), "shipment total pieces")},
    updated_at=GREATEST(${now}::timestamp,updated_at+interval '1 millisecond') WHERE id=${shipment.id}`);
  if (purpose === "shipment") return amendmentId;
  const lifecycle = correctedReceiptLifecycle({
    closed:
      po.closed_at != null ||
      po.status === "closed" ||
      po.physical_status === "closed",
    status: String(po.status),
    physicalStatus:
      po.physical_status == null ? null : String(po.physical_status),
    targetId: integer(poLine.id, "PO line", 1),
    targetReceived: plan.poReceivedPieces,
    targetOrdered: source.facts.orderPieces,
    targetCancelled: source.facts.cancelledPieces,
    lines: poLines.map((row) => ({
      id: integer(row.id, "PO line", 1),
      status: String(row.status),
      lineType: row.line_type == null ? null : String(row.line_type),
    })),
  });
  await tx.execute(sql`UPDATE procurement.purchase_order_lines SET received_qty=${plan.poReceivedPieces},
    status=${lifecycle.lineStatus},updated_at=GREATEST(${now}::timestamp,updated_at+interval '1 millisecond')
    WHERE id=${poLine.id}`);
  await tx.execute(sql`UPDATE procurement.purchase_orders SET received_line_count=${lifecycle.receivedLineCount},
    status=${lifecycle.status},
    physical_status=${lifecycle.physicalStatus},
    updated_by=${actorId},updated_at=GREATEST(${now}::timestamp,updated_at+interval '1 millisecond') WHERE id=${po.id}`);
  return amendmentId;
}
export async function recordQuantityCorrectionResult(
  tx: AmendmentTransaction,
  source: QuantityCorrectionSource,
  amendmentId: number,
  summary: QuantityCorrectionSummary,
  actorId: string,
  now: Date,
) {
  await tx.execute(sql`INSERT INTO procurement.receipt_shipment_quantity_results(amendment_id,summary)
    VALUES(${amendmentId},${canonicalJson(summary)}::jsonb)`);
  await tx.execute(sql`INSERT INTO procurement.po_events(po_id,event_type,actor_type,actor_id,payload_json,created_at)
    VALUES(${source.evidence.po.id},${summary.purpose === "shipment" ? "shipment_quantity_corrected" : "receipt_quantity_corrected"},'user',${actorId},
    ${canonicalJson({ contractVersion: 1, amendmentId, summary })}::jsonb,${now})`);
  const action =
    summary.purpose === "shipment"
      ? "shipment edit"
      : "receipt and shipment correction";
  const notes = `Administrator approved ${action} #${amendmentId}: shipment ${summary.shipmentPieces.before} → ${summary.shipmentPieces.after} pieces; PO received ${summary.poReceivedPieces.before} → ${summary.poReceivedPieces.after} pieces. Original stock movements and supplier charges preserved.`;
  const current = (
    await tx.execute(
      sql`SELECT status FROM procurement.purchase_orders WHERE id=${source.evidence.po.id}`,
    )
  ).rows[0];
  await tx.insert(poStatusHistory).values({
    purchaseOrderId: integer(source.evidence.po.id, "PO", 1),
    fromStatus: String(source.evidence.po.status),
    toStatus: String(current.status),
    changedBy: actorId,
    changedAt: now,
    notes,
  });
  await tx.insert(inboundShipmentStatusHistory).values({
    inboundShipmentId: integer(source.evidence.shipment.id, "shipment", 1),
    fromStatus: String(source.evidence.shipment.status),
    toStatus: String(source.evidence.shipment.status),
    changedBy: actorId,
    changedAt: now,
    notes,
  });
}
