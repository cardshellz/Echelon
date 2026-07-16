import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";

const REMEDIATION_CONTRACT_VERSION = 1;
const REMEDIATION_ADVISORY_LOCK = 1_947_206_147;

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<QueryResult<any>>;
};

export type ReceivingEvidence = {
  receivingLineId: number;
  status: string;
  productVariantId: number | null;
  variantProductId: number | null;
  variantActive: boolean | null;
  unitsPerVariant: number | null;
  expectedVariantQty: number;
  receivedVariantQty: number;
  receiptBaseQty: number;
};

type ReplacementMapping = {
  vendorProductId: number;
  productVariantId: number;
  variantProductId: number;
  variantActive: boolean;
  unitsPerVariant: number;
};

export type LegacyPoReceiveConfigTarget = {
  lineId: number;
  purchaseOrderId: number;
  poNumber: string;
  poStatus: string;
  lineStatus: string;
  vendorId: number;
  productId: number;
  lineSku: string | null;
  orderQty: number;
  receivedQty: number;
  currentVendorProductId: number;
  currentMappingVariantId: number;
  currentMappingVariantSku: string | null;
  currentMappingVariantName: string;
  currentMappingVariantProductId: number;
  currentMappingActive: boolean;
  currentMappingVariantActive: boolean;
  currentMappingUnitsPerVariant: number;
  action:
    | "stamp_linked_mapping_configuration"
    | "relink_to_corroborated_received_configuration"
    | "blocked";
  targetVendorProductId: number | null;
  targetReceiveVariantId: number | null;
  targetReceiveUnitsPerVariant: number | null;
  receivingEvidence: ReceivingEvidence[];
  warnings: string[];
  blockers: string[];
};

export type LegacyPoReceiveConfigPreview = {
  mode: "preview";
  contractVersion: number;
  generatedAt: string;
  previewHash: string;
  summary: {
    candidateLines: number;
    safeLines: number;
    linesToStamp: number;
    linesToRelink: number;
    blockedLines: number;
    linesWithoutReceivingEvidence: number;
    receiptVariantDeviations: number;
  };
  targets: LegacyPoReceiveConfigTarget[];
};

export type LegacyPoReceiveConfigApplyResult = {
  mode: "apply";
  contractVersion: number;
  previewHash: string;
  actorId: string;
  stampedLines: number;
  relinkedLines: number;
  auditedLines: number;
};

const CANDIDATE_QUERY = `
  SELECT
    pol.id AS line_id,
    pol.purchase_order_id,
    po.po_number,
    po.status AS po_status,
    pol.status AS line_status,
    po.vendor_id,
    pol.product_id,
    pol.sku AS line_sku,
    pol.order_qty,
    pol.received_qty,
    pol.vendor_product_id AS current_vendor_product_id,
    vp.product_variant_id AS current_mapping_variant_id,
    mapping_variant.sku AS current_mapping_variant_sku,
    mapping_variant.name AS current_mapping_variant_name,
    mapping_variant.product_id AS current_mapping_variant_product_id,
    vp.is_active AS current_mapping_active,
    mapping_variant.is_active AS current_mapping_variant_active,
    mapping_variant.units_per_variant AS current_mapping_units_per_variant,
    COALESCE(receiving.evidence, '[]'::jsonb) AS receiving_evidence,
    COALESCE(replacements.mappings, '[]'::jsonb) AS replacement_mappings
  FROM procurement.purchase_order_lines pol
  JOIN procurement.purchase_orders po
    ON po.id = pol.purchase_order_id
  JOIN procurement.vendor_products vp
    ON vp.id = pol.vendor_product_id
  JOIN catalog.product_variants mapping_variant
    ON mapping_variant.id = vp.product_variant_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'receivingLineId', rl.id,
        'status', rl.status,
        'productVariantId', rl.product_variant_id,
        'variantProductId', received_variant.product_id,
        'variantActive', received_variant.is_active,
        'unitsPerVariant', received_variant.units_per_variant,
        'expectedVariantQty', rl.expected_qty,
        'receivedVariantQty', rl.received_qty,
        'receiptBaseQty', COALESCE(receipts.receipt_base_qty, 0)
      )
      ORDER BY rl.id
    ) AS evidence
    FROM procurement.receiving_lines rl
    LEFT JOIN catalog.product_variants received_variant
      ON received_variant.id = rl.product_variant_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(pr.qty_received), 0)::int AS receipt_base_qty
      FROM procurement.po_receipts pr
      WHERE pr.purchase_order_line_id = pol.id
        AND pr.receiving_line_id = rl.id
    ) receipts ON TRUE
    WHERE rl.purchase_order_line_id = pol.id
  ) receiving ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'vendorProductId', candidate_vp.id,
        'productVariantId', candidate_vp.product_variant_id,
        'variantProductId', candidate_variant.product_id,
        'variantActive', candidate_variant.is_active,
        'unitsPerVariant', candidate_variant.units_per_variant
      )
      ORDER BY candidate_vp.id
    ) AS mappings
    FROM procurement.vendor_products candidate_vp
    JOIN catalog.product_variants candidate_variant
      ON candidate_variant.id = candidate_vp.product_variant_id
    WHERE candidate_vp.vendor_id = po.vendor_id
      AND candidate_vp.product_id = pol.product_id
      AND candidate_vp.id <> vp.id
      AND candidate_vp.is_active = 1
  ) replacements ON TRUE
  WHERE pol.line_type = 'product'
    AND pol.product_id IS NOT NULL
    AND pol.vendor_product_id IS NOT NULL
    AND vp.product_variant_id IS NOT NULL
    AND pol.product_variant_id IS NULL
    AND pol.expected_receive_variant_id IS NULL
    AND vp.vendor_id = po.vendor_id
    AND vp.product_id = pol.product_id
  ORDER BY pol.id
`;

const LOCK_CANDIDATE_QUERY = `
  SELECT pol.id AS line_id
  FROM procurement.purchase_order_lines pol
  JOIN procurement.purchase_orders po
    ON po.id = pol.purchase_order_id
  JOIN procurement.vendor_products vp
    ON vp.id = pol.vendor_product_id
  JOIN catalog.product_variants mapping_variant
    ON mapping_variant.id = vp.product_variant_id
  WHERE pol.line_type = 'product'
    AND pol.product_id IS NOT NULL
    AND pol.vendor_product_id IS NOT NULL
    AND vp.product_variant_id IS NOT NULL
    AND pol.product_variant_id IS NULL
    AND pol.expected_receive_variant_id IS NULL
    AND vp.vendor_id = po.vendor_id
    AND vp.product_id = pol.product_id
  ORDER BY pol.id
  FOR UPDATE OF pol, po, vp, mapping_variant
`;

function asSafeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} is not a safe integer`);
  }
  return parsed;
}

function asOptionalSafeInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined
    ? null
    : asSafeInteger(value, field);
}

function parseReceivingEvidence(value: unknown): ReceivingEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const row = entry as Record<string, unknown>;
    return {
      receivingLineId: asSafeInteger(
        row.receivingLineId,
        `receiving_evidence[${index}].receivingLineId`,
      ),
      status: String(row.status),
      productVariantId: asOptionalSafeInteger(
        row.productVariantId,
        `receiving_evidence[${index}].productVariantId`,
      ),
      variantProductId: asOptionalSafeInteger(
        row.variantProductId,
        `receiving_evidence[${index}].variantProductId`,
      ),
      variantActive: row.variantActive == null ? null : Boolean(row.variantActive),
      unitsPerVariant: asOptionalSafeInteger(
        row.unitsPerVariant,
        `receiving_evidence[${index}].unitsPerVariant`,
      ),
      expectedVariantQty: asSafeInteger(
        row.expectedVariantQty,
        `receiving_evidence[${index}].expectedVariantQty`,
      ),
      receivedVariantQty: asSafeInteger(
        row.receivedVariantQty,
        `receiving_evidence[${index}].receivedVariantQty`,
      ),
      receiptBaseQty: asSafeInteger(
        row.receiptBaseQty,
        `receiving_evidence[${index}].receiptBaseQty`,
      ),
    };
  });
}

function parseReplacementMappings(value: unknown): ReplacementMapping[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const row = entry as Record<string, unknown>;
    return {
      vendorProductId: asSafeInteger(
        row.vendorProductId,
        `replacement_mappings[${index}].vendorProductId`,
      ),
      productVariantId: asSafeInteger(
        row.productVariantId,
        `replacement_mappings[${index}].productVariantId`,
      ),
      variantProductId: asSafeInteger(
        row.variantProductId,
        `replacement_mappings[${index}].variantProductId`,
      ),
      variantActive: Boolean(row.variantActive),
      unitsPerVariant: asSafeInteger(
        row.unitsPerVariant,
        `replacement_mappings[${index}].unitsPerVariant`,
      ),
    };
  });
}

function activeReceiptEvidence(
  evidence: ReceivingEvidence[],
): ReceivingEvidence[] {
  return evidence.filter((entry) =>
    entry.status !== "cancelled"
    && (entry.receivedVariantQty > 0 || entry.receiptBaseQty > 0)
  );
}

function uniqueReceiptVariantIds(evidence: ReceivingEvidence[]): number[] {
  return [...new Set(
    activeReceiptEvidence(evidence)
      .map((entry) => entry.productVariantId)
      .filter((value): value is number => value !== null),
  )].sort((a, b) => a - b);
}

function receiptEvidenceIsExact(
  evidence: ReceivingEvidence[],
  productId: number,
  variantId: number,
  unitsPerVariant: number,
  lineReceivedQty: number,
): boolean {
  const active = activeReceiptEvidence(evidence);
  if (active.length === 0) return false;
  if (active.some((entry) =>
    entry.productVariantId !== variantId
    || entry.variantProductId !== productId
    || entry.variantActive !== true
    || entry.unitsPerVariant !== unitsPerVariant
    || entry.receivedVariantQty <= 0
    || entry.receiptBaseQty !== entry.receivedVariantQty * unitsPerVariant
  )) {
    return false;
  }
  return active.reduce((sum, entry) => sum + entry.receiptBaseQty, 0)
    === lineReceivedQty;
}

function classifyRow(row: Record<string, unknown>): LegacyPoReceiveConfigTarget {
  const productId = asSafeInteger(row.product_id, "product_id");
  const orderQty = asSafeInteger(row.order_qty, "order_qty");
  const receivedQty = asSafeInteger(row.received_qty, "received_qty");
  const currentMappingVariantId = asSafeInteger(
    row.current_mapping_variant_id,
    "current_mapping_variant_id",
  );
  const currentMappingVariantProductId = asSafeInteger(
    row.current_mapping_variant_product_id,
    "current_mapping_variant_product_id",
  );
  const currentMappingUnitsPerVariant = asSafeInteger(
    row.current_mapping_units_per_variant,
    "current_mapping_units_per_variant",
  );
  const currentMappingVariantActive = Boolean(row.current_mapping_variant_active);
  const currentMappingActive = asSafeInteger(
    row.current_mapping_active,
    "current_mapping_active",
  ) === 1;
  const receivingEvidence = parseReceivingEvidence(row.receiving_evidence);
  const replacementMappings = parseReplacementMappings(row.replacement_mappings);
  const operationalReceivingEvidence = activeReceiptEvidence(receivingEvidence);
  const receiptVariantIds = uniqueReceiptVariantIds(receivingEvidence);
  const warnings: string[] = [];
  const blockers: string[] = [];

  if (operationalReceivingEvidence.length === 0) {
    warnings.push("no_receiving_evidence");
  }

  if (
    receiptVariantIds.length > 0
    && receiptVariantIds.some((variantId) => variantId !== currentMappingVariantId)
  ) {
    warnings.push("actual_receipt_variant_differs_from_expected_mapping");
  }

  let action: LegacyPoReceiveConfigTarget["action"] = "blocked";
  let targetVendorProductId: number | null = null;
  let targetReceiveVariantId: number | null = null;
  let targetReceiveUnitsPerVariant: number | null = null;

  if (!currentMappingActive) {
    blockers.push("linked_supplier_mapping_is_inactive");
  } else if (currentMappingVariantProductId !== productId) {
    blockers.push("linked_mapping_variant_belongs_to_another_product");
  } else if (currentMappingUnitsPerVariant <= 0) {
    blockers.push("linked_mapping_variant_has_invalid_units");
  } else if (currentMappingVariantActive) {
    if (orderQty % currentMappingUnitsPerVariant !== 0) {
      blockers.push("ordered_pieces_do_not_align_to_linked_mapping_units");
    } else {
      action = "stamp_linked_mapping_configuration";
      targetVendorProductId = asSafeInteger(
        row.current_vendor_product_id,
        "current_vendor_product_id",
      );
      targetReceiveVariantId = currentMappingVariantId;
      targetReceiveUnitsPerVariant = currentMappingUnitsPerVariant;
    }
  } else {
    const receivedVariantId = receiptVariantIds.length === 1
      ? receiptVariantIds[0]
      : null;
    if (receivedVariantId !== null && receivedVariantId !== currentMappingVariantId) {
      const replacements = replacementMappings.filter((candidate) =>
        candidate.productVariantId === receivedVariantId
        && candidate.variantProductId === productId
        && candidate.variantActive
        && candidate.unitsPerVariant > 0
      );
      if (replacements.length !== 1) {
        blockers.push("inactive_mapping_lacks_one_active_replacement_mapping");
      } else {
        const replacement = replacements[0];
        if (orderQty % replacement.unitsPerVariant !== 0) {
          blockers.push("ordered_pieces_do_not_align_to_replacement_units");
        } else if (!receiptEvidenceIsExact(
          receivingEvidence,
          productId,
          replacement.productVariantId,
          replacement.unitsPerVariant,
          receivedQty,
        )) {
          blockers.push("received_configuration_evidence_is_not_exact");
        } else {
          action = "relink_to_corroborated_received_configuration";
          targetVendorProductId = replacement.vendorProductId;
          targetReceiveVariantId = replacement.productVariantId;
          targetReceiveUnitsPerVariant = replacement.unitsPerVariant;
        }
      }
    } else if (receiptVariantIds.length > 1) {
      blockers.push("archived_mapping_has_multiple_received_variants");
    } else if (orderQty % currentMappingUnitsPerVariant !== 0) {
      blockers.push("ordered_pieces_do_not_align_to_archived_mapping_units");
    } else {
      warnings.push("expected_mapping_variant_is_archived");
      action = "stamp_linked_mapping_configuration";
      targetVendorProductId = asSafeInteger(
        row.current_vendor_product_id,
        "current_vendor_product_id",
      );
      targetReceiveVariantId = currentMappingVariantId;
      targetReceiveUnitsPerVariant = currentMappingUnitsPerVariant;
    }
  }

  if (blockers.length > 0) {
    action = "blocked";
    targetVendorProductId = null;
    targetReceiveVariantId = null;
    targetReceiveUnitsPerVariant = null;
  }

  return {
    lineId: asSafeInteger(row.line_id, "line_id"),
    purchaseOrderId: asSafeInteger(row.purchase_order_id, "purchase_order_id"),
    poNumber: String(row.po_number),
    poStatus: String(row.po_status),
    lineStatus: String(row.line_status),
    vendorId: asSafeInteger(row.vendor_id, "vendor_id"),
    productId,
    lineSku: row.line_sku == null ? null : String(row.line_sku),
    orderQty,
    receivedQty,
    currentVendorProductId: asSafeInteger(
      row.current_vendor_product_id,
      "current_vendor_product_id",
    ),
    currentMappingVariantId,
    currentMappingVariantSku:
      row.current_mapping_variant_sku == null
        ? null
        : String(row.current_mapping_variant_sku),
    currentMappingVariantName: String(row.current_mapping_variant_name),
    currentMappingVariantProductId,
    currentMappingActive,
    currentMappingVariantActive,
    currentMappingUnitsPerVariant,
    action,
    targetVendorProductId,
    targetReceiveVariantId,
    targetReceiveUnitsPerVariant,
    receivingEvidence,
    warnings,
    blockers,
  };
}

function previewFingerprint(targets: LegacyPoReceiveConfigTarget[]): string {
  return createHash("sha256")
    .update(`legacy-po-receive-config:v${REMEDIATION_CONTRACT_VERSION}:`)
    .update(JSON.stringify(targets))
    .digest("hex");
}

async function previewWithQueryable(
  queryable: Queryable,
): Promise<LegacyPoReceiveConfigPreview> {
  const result = await queryable.query(CANDIDATE_QUERY);
  const targets = result.rows.map((row) => classifyRow(row));
  return {
    mode: "preview",
    contractVersion: REMEDIATION_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    previewHash: previewFingerprint(targets),
    summary: {
      candidateLines: targets.length,
      safeLines: targets.filter((target) => target.action !== "blocked").length,
      linesToStamp: targets.filter((target) =>
        target.action === "stamp_linked_mapping_configuration"
      ).length,
      linesToRelink: targets.filter((target) =>
        target.action === "relink_to_corroborated_received_configuration"
      ).length,
      blockedLines: targets.filter((target) => target.action === "blocked").length,
      linesWithoutReceivingEvidence: targets.filter((target) =>
        target.warnings.includes("no_receiving_evidence")
      ).length,
      receiptVariantDeviations: targets.filter((target) =>
        target.warnings.includes(
          "actual_receipt_variant_differs_from_expected_mapping",
        )
      ).length,
    },
    targets,
  };
}

export async function previewLegacyPoReceiveConfigRemediation(
  queryable: Queryable,
): Promise<LegacyPoReceiveConfigPreview> {
  return previewWithQueryable(queryable);
}

async function assertActor(client: PoolClient, actorId: string): Promise<void> {
  const actor = await client.query(
    "SELECT id FROM public.users WHERE id = $1 LIMIT 1",
    [actorId],
  );
  if (actor.rowCount !== 1) {
    throw new Error("--actor must identify an existing application user");
  }
}

export async function applyLegacyPoReceiveConfigRemediation(input: {
  pool: Pool;
  actorId: string;
  expectedPreviewHash: string;
}): Promise<LegacyPoReceiveConfigApplyResult> {
  const actorId = input.actorId.trim();
  if (!actorId) throw new Error("actorId is required");
  if (!/^[0-9a-f]{64}$/.test(input.expectedPreviewHash)) {
    throw new Error("expectedPreviewHash must be a SHA-256 hash from preview");
  }

  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      REMEDIATION_ADVISORY_LOCK,
    ]);
    await assertActor(client, actorId);
    const lockedCandidates = await client.query(LOCK_CANDIDATE_QUERY);
    const lockedLineIds = lockedCandidates.rows.map((row) =>
      asSafeInteger(row.line_id, "locked_line_id")
    );
    if (lockedLineIds.length > 0) {
      await client.query(
        `SELECT id
         FROM procurement.receiving_lines
         WHERE purchase_order_line_id = ANY($1::int[])
         ORDER BY id
         FOR UPDATE`,
        [lockedLineIds],
      );
      await client.query(
        `SELECT id
         FROM procurement.po_receipts
         WHERE purchase_order_line_id = ANY($1::int[])
         ORDER BY id
         FOR UPDATE`,
        [lockedLineIds],
      );
      await client.query(
        `SELECT candidate_vp.id
         FROM procurement.vendor_products candidate_vp
         JOIN catalog.product_variants candidate_variant
           ON candidate_variant.id = candidate_vp.product_variant_id
         WHERE EXISTS (
           SELECT 1
           FROM procurement.purchase_order_lines pol
           JOIN procurement.purchase_orders po
             ON po.id = pol.purchase_order_id
           WHERE pol.id = ANY($1::int[])
             AND candidate_vp.vendor_id = po.vendor_id
             AND candidate_vp.product_id = pol.product_id
         )
         ORDER BY candidate_vp.id
         FOR UPDATE OF candidate_vp, candidate_variant`,
        [lockedLineIds],
      );
    }
    const preview = await previewWithQueryable(client);
    if (preview.previewHash !== input.expectedPreviewHash) {
      throw new Error(
        "Legacy PO receive configuration changed after preview; run preview again",
      );
    }
    if (preview.summary.blockedLines > 0) {
      throw new Error(
        "Legacy PO receive configuration preview contains blocked lines; no writes applied",
      );
    }

    let stampedLines = 0;
    let relinkedLines = 0;
    let auditedLines = 0;

    for (const target of preview.targets) {
      if (
        target.targetVendorProductId === null
        || target.targetReceiveVariantId === null
        || target.targetReceiveUnitsPerVariant === null
      ) {
        throw new Error(`Line ${target.lineId} has no safe remediation target`);
      }

      const beforeResult = await client.query(
        `SELECT to_jsonb(pol) AS row
         FROM procurement.purchase_order_lines pol
         WHERE pol.id = $1
           AND pol.vendor_product_id = $2
           AND pol.product_variant_id IS NULL
           AND pol.expected_receive_variant_id IS NULL
         FOR UPDATE`,
        [target.lineId, target.currentVendorProductId],
      );
      if (beforeResult.rowCount !== 1) {
        throw new Error(
          `Line ${target.lineId} changed during remediation; roll back and preview again`,
        );
      }

      const updated = await client.query(
        `UPDATE procurement.purchase_order_lines AS pol
         SET vendor_product_id = $2,
             expected_receive_variant_id = $3,
             expected_receive_units_per_variant = $4,
             updated_at = GREATEST(pol.updated_at, LOCALTIMESTAMP)
         WHERE pol.id = $1
           AND pol.vendor_product_id = $5
           AND pol.product_variant_id IS NULL
           AND pol.expected_receive_variant_id IS NULL
         RETURNING to_jsonb(pol) AS row`,
        [
          target.lineId,
          target.targetVendorProductId,
          target.targetReceiveVariantId,
          target.targetReceiveUnitsPerVariant,
          target.currentVendorProductId,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `Line ${target.lineId} changed during remediation; roll back and preview again`,
        );
      }

      if (target.action === "stamp_linked_mapping_configuration") {
        stampedLines++;
      } else {
        relinkedLines++;
      }

      await client.query(
        `INSERT INTO public.audit_events (
           level, actor, action, target, changes, context
         ) VALUES (
           'AUDIT', $1,
           'purchase_order_line.receive_configuration_recovered',
           $2, $3::jsonb, $4::jsonb
         )`,
        [
          `user:${actorId}`,
          `purchase_order_line:${target.lineId}`,
          JSON.stringify({
            before: beforeResult.rows[0].row,
            after: updated.rows[0].row,
          }),
          JSON.stringify({
            contractVersion: REMEDIATION_CONTRACT_VERSION,
            source: "legacy_po_link_and_receiving_evidence",
            previewHash: preview.previewHash,
            action: target.action,
            purchaseOrderId: target.purchaseOrderId,
            poNumber: target.poNumber,
            vendorId: target.vendorId,
            productId: target.productId,
            currentVendorProductId: target.currentVendorProductId,
            targetVendorProductId: target.targetVendorProductId,
            targetReceiveVariantId: target.targetReceiveVariantId,
            targetReceiveUnitsPerVariant:
              target.targetReceiveUnitsPerVariant,
            receivingEvidence: target.receivingEvidence,
            warnings: target.warnings,
          }),
        ],
      );
      auditedLines++;
    }

    await client.query("COMMIT");
    return {
      mode: "apply",
      contractVersion: REMEDIATION_CONTRACT_VERSION,
      previewHash: preview.previewHash,
      actorId,
      stampedLines,
      relinkedLines,
      auditedLines,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    client.release();
  }
}
