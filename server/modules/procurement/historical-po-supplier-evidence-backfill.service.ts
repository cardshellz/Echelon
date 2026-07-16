import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";

const BACKFILL_CONTRACT_VERSION = 1;
const BACKFILL_ADVISORY_LOCK = 1_947_206_126;

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<QueryResult<any>>;
};

export type HistoricalSupplierEvidenceTarget = {
  vendorId: number;
  vendorName: string;
  productId: number;
  productName: string;
  productVariantId: number | null;
  sku: string | null;
  sourcePurchaseOrderId: number;
  sourcePoNumber: string;
  sourceCompletedAt: string;
  sourceReceivedQty: number;
  sourceLineIds: number[];
  lastCostMills: number;
  lastCostCents: number;
  vendorProductId: number | null;
  currentLastPurchasedAt: string | null;
  currentLastCostMills: number | null;
  currentLastCostCents: number | null;
  action: "create_mapping" | "update_purchase_evidence" | "link_lines" | "unchanged";
  linesToLink: number[];
  conflictingLineIds: number[];
};

export type HistoricalSupplierEvidencePreview = {
  mode: "preview";
  contractVersion: number;
  generatedAt: string;
  previewHash: string;
  excludedVendorIds: number[];
  summary: {
    targetCount: number;
    mappingsToCreate: number;
    mappingsToUpdate: number;
    mappingsUnchanged: number;
    linesToLink: number;
    conflictingLines: number;
    nonpositiveCostLinesExcluded: number;
  };
  targets: HistoricalSupplierEvidenceTarget[];
};

export type HistoricalSupplierEvidenceApplyResult = {
  mode: "apply";
  contractVersion: number;
  previewHash: string;
  actorId: string;
  excludedVendorIds: number[];
  createdMappings: number;
  updatedMappings: number;
  linkedLines: number;
  conflictingLinesSkipped: number;
  nonpositiveCostLinesExcluded: number;
  unchangedTargets: number;
};

const EVIDENCE_QUERY = `
  WITH raw_lines AS (
    SELECT
      po.id AS purchase_order_id,
      po.po_number,
      po.vendor_id,
      pol.id AS line_id,
      pol.product_id,
      CASE
        WHEN linked_vp.id IS NOT NULL
          AND linked_vp.vendor_id = po.vendor_id
          AND linked_vp.product_id = pol.product_id
        THEN linked_vp.product_variant_id
        ELSE COALESCE(pol.expected_receive_variant_id, pol.product_variant_id)
      END AS product_variant_id,
      pol.unit_cost_cents,
      COALESCE(pol.unit_cost_mills, pol.unit_cost_cents * 100) AS unit_cost_mills,
      pol.received_qty,
      COALESCE(
        po.closed_at,
        pol.fully_received_date,
        pol.last_received_at,
        po.updated_at
      ) AS completed_at
    FROM procurement.purchase_order_lines pol
    JOIN procurement.purchase_orders po ON po.id = pol.purchase_order_id
    LEFT JOIN procurement.vendor_products linked_vp ON linked_vp.id = pol.vendor_product_id
    WHERE pol.line_type = 'product'
      AND po.status IN ('received', 'closed')
      AND pol.status <> 'cancelled'
      AND pol.received_qty > 0
      AND COALESCE(pol.unit_cost_mills, pol.unit_cost_cents * 100) > 0
  ),
  eligible_lines AS (
    SELECT raw.*
    FROM raw_lines raw
    JOIN procurement.vendors v ON v.id = raw.vendor_id AND v.active = 1
    JOIN catalog.products p ON p.id = raw.product_id AND p.is_active IS TRUE
    LEFT JOIN catalog.product_variants pv ON pv.id = raw.product_variant_id
    WHERE (
        raw.product_variant_id IS NULL
        OR (pv.is_active IS TRUE AND pv.product_id = raw.product_id)
      )
  ),
  po_evidence AS (
    SELECT
      purchase_order_id,
      po_number,
      vendor_id,
      product_id,
      product_variant_id,
      MAX(completed_at) AS completed_at,
      SUM(received_qty)::int AS received_qty,
      FLOOR(
        SUM(unit_cost_mills::numeric * received_qty::numeric)
        / NULLIF(SUM(received_qty)::numeric, 0)
        + 0.5
      )::bigint AS last_cost_mills,
      ARRAY_AGG(line_id ORDER BY line_id) AS line_ids
    FROM eligible_lines
    GROUP BY
      purchase_order_id,
      po_number,
      vendor_id,
      product_id,
      product_variant_id
  ),
  ranked AS (
    SELECT
      evidence.*,
      ROW_NUMBER() OVER (
        PARTITION BY vendor_id, product_id, COALESCE(product_variant_id, 0)
        ORDER BY completed_at DESC, purchase_order_id DESC
      ) AS evidence_rank
    FROM po_evidence evidence
  )
  SELECT
    ranked.vendor_id,
    v.name AS vendor_name,
    ranked.product_id,
    p.name AS product_name,
    ranked.product_variant_id,
    COALESCE(pv.sku, p.sku) AS sku,
    ranked.purchase_order_id,
    ranked.po_number,
    ranked.completed_at,
    ranked.received_qty,
    ranked.last_cost_mills,
    FLOOR((ranked.last_cost_mills::numeric + 50) / 100)::bigint AS last_cost_cents,
    ranked.line_ids,
    vp.id AS vendor_product_id,
    vp.last_purchased_at AS current_last_purchased_at,
    (to_jsonb(vp)->>'last_cost_mills')::bigint AS current_last_cost_mills,
    vp.last_cost_cents AS current_last_cost_cents,
    COALESCE((
      SELECT ARRAY_AGG(el.line_id ORDER BY el.line_id)
      FROM eligible_lines el
      WHERE el.vendor_id = ranked.vendor_id
        AND el.product_id = ranked.product_id
        AND COALESCE(el.product_variant_id, 0) = COALESCE(ranked.product_variant_id, 0)
        AND el.line_id IN (
          SELECT pol2.id
          FROM procurement.purchase_order_lines pol2
          WHERE pol2.vendor_product_id IS NULL
        )
    ), ARRAY[]::int[]) AS lines_to_link,
    COALESCE((
      SELECT ARRAY_AGG(el.line_id ORDER BY el.line_id)
      FROM eligible_lines el
      JOIN procurement.purchase_order_lines pol3 ON pol3.id = el.line_id
      WHERE el.vendor_id = ranked.vendor_id
        AND el.product_id = ranked.product_id
        AND COALESCE(el.product_variant_id, 0) = COALESCE(ranked.product_variant_id, 0)
        AND pol3.vendor_product_id IS NOT NULL
        AND (vp.id IS NULL OR pol3.vendor_product_id <> vp.id)
    ), ARRAY[]::int[]) AS conflicting_line_ids
  FROM ranked
  JOIN procurement.vendors v ON v.id = ranked.vendor_id
  JOIN catalog.products p ON p.id = ranked.product_id
  LEFT JOIN catalog.product_variants pv ON pv.id = ranked.product_variant_id
  LEFT JOIN procurement.vendor_products vp
    ON vp.vendor_id = ranked.vendor_id
    AND vp.product_id = ranked.product_id
    AND COALESCE(vp.product_variant_id, 0) = COALESCE(ranked.product_variant_id, 0)
  WHERE ranked.evidence_rank = 1
  ORDER BY
    ranked.completed_at DESC,
    ranked.vendor_id,
    ranked.product_id,
    COALESCE(ranked.product_variant_id, 0)
`;

const NONPOSITIVE_COST_QUERY = `
  SELECT
    po.vendor_id,
    COUNT(*)::int AS nonpositive_cost_lines_excluded
  FROM procurement.purchase_order_lines pol
  JOIN procurement.purchase_orders po ON po.id = pol.purchase_order_id
  JOIN procurement.vendors v ON v.id = po.vendor_id AND v.active = 1
  JOIN catalog.products p ON p.id = pol.product_id AND p.is_active IS TRUE
  LEFT JOIN catalog.product_variants pv
    ON pv.id = COALESCE(pol.expected_receive_variant_id, pol.product_variant_id)
  WHERE pol.line_type = 'product'
    AND po.status IN ('received', 'closed')
    AND pol.status <> 'cancelled'
    AND pol.received_qty > 0
    AND COALESCE(pol.unit_cost_mills, pol.unit_cost_cents * 100) <= 0
    AND (
      COALESCE(pol.expected_receive_variant_id, pol.product_variant_id) IS NULL
      OR (
        pv.is_active IS TRUE
        AND pv.product_id = pol.product_id
      )
    )
  GROUP BY po.vendor_id
`;

function asSafeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} is not a safe integer`);
  return parsed;
}

function asOptionalSafeInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : asSafeInteger(value, field);
}

function asIso(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error("Historical purchase evidence has an invalid date");
  return parsed.toISOString();
}

function rowTarget(row: Record<string, any>): HistoricalSupplierEvidenceTarget {
  const vendorProductId = asOptionalSafeInteger(row.vendor_product_id, "vendor_product_id");
  const completedAt = asIso(row.completed_at);
  const currentPurchasedAt = row.current_last_purchased_at == null
    ? null
    : asIso(row.current_last_purchased_at);
  const lastCostCents = asSafeInteger(row.last_cost_cents, "last_cost_cents");
  const lastCostMills = asSafeInteger(row.last_cost_mills, "last_cost_mills");
  const currentLastCostMills = asOptionalSafeInteger(
    row.current_last_cost_mills,
    "current_last_cost_mills",
  );
  const currentLastCostCents = asOptionalSafeInteger(
    row.current_last_cost_cents,
    "current_last_cost_cents",
  );
  const sourceLineIds = (row.line_ids ?? []).map((value: unknown) =>
    asSafeInteger(value, "line_id")
  );
  const linesToLink = (row.lines_to_link ?? []).map((value: unknown) =>
    asSafeInteger(value, "line_to_link")
  );
  const conflictingLineIds = (row.conflicting_line_ids ?? []).map((value: unknown) =>
    asSafeInteger(value, "conflicting_line_id")
  );
  const evidenceChanged = currentPurchasedAt === null ||
    currentPurchasedAt < completedAt ||
    (
      currentPurchasedAt === completedAt &&
      (
        currentLastCostMills !== lastCostMills ||
        currentLastCostCents !== lastCostCents
      )
    );
  const action = vendorProductId === null
    ? "create_mapping"
    : evidenceChanged
      ? "update_purchase_evidence"
      : linesToLink.length > 0
        ? "link_lines"
        : "unchanged";

  return {
    vendorId: asSafeInteger(row.vendor_id, "vendor_id"),
    vendorName: String(row.vendor_name),
    productId: asSafeInteger(row.product_id, "product_id"),
    productName: String(row.product_name),
    productVariantId: asOptionalSafeInteger(row.product_variant_id, "product_variant_id"),
    sku: row.sku == null ? null : String(row.sku),
    sourcePurchaseOrderId: asSafeInteger(row.purchase_order_id, "purchase_order_id"),
    sourcePoNumber: String(row.po_number),
    sourceCompletedAt: completedAt,
    sourceReceivedQty: asSafeInteger(row.received_qty, "received_qty"),
    sourceLineIds,
    lastCostMills,
    lastCostCents,
    vendorProductId,
    currentLastPurchasedAt: currentPurchasedAt,
    currentLastCostMills,
    currentLastCostCents,
    action,
    linesToLink,
    conflictingLineIds,
  };
}

function previewFingerprint(
  targets: HistoricalSupplierEvidenceTarget[],
  excludedVendorIds: number[],
  nonpositiveCostLinesExcluded: number,
): string {
  const canonical = {
    excludedVendorIds,
    nonpositiveCostLinesExcluded,
    targets: targets.map((target) => ({
      vendorId: target.vendorId,
      productId: target.productId,
      productVariantId: target.productVariantId,
      sourcePurchaseOrderId: target.sourcePurchaseOrderId,
      sourceCompletedAt: target.sourceCompletedAt,
      sourceLineIds: target.sourceLineIds,
      lastCostMills: target.lastCostMills,
      lastCostCents: target.lastCostCents,
      vendorProductId: target.vendorProductId,
      currentLastPurchasedAt: target.currentLastPurchasedAt,
      currentLastCostMills: target.currentLastCostMills,
      currentLastCostCents: target.currentLastCostCents,
      linesToLink: target.linesToLink,
      conflictingLineIds: target.conflictingLineIds,
    })),
  };
  return createHash("sha256")
    .update(`historical-po-supplier-evidence:v${BACKFILL_CONTRACT_VERSION}:`)
    .update(JSON.stringify(canonical))
    .digest("hex");
}

async function previewWithQueryable(
  queryable: Queryable,
  options: { excludedVendorIds?: number[] } = {},
): Promise<HistoricalSupplierEvidencePreview> {
  const excludedVendorIds = [...new Set(options.excludedVendorIds ?? [])].sort((a, b) => a - b);
  const excluded = new Set(excludedVendorIds);
  const result = await queryable.query(EVIDENCE_QUERY);
  const nonpositiveCostResult = await queryable.query(NONPOSITIVE_COST_QUERY);
  const nonpositiveCostLinesExcluded = nonpositiveCostResult.rows.reduce(
    (sum, row) => excluded.has(asSafeInteger(row.vendor_id, "vendor_id"))
      ? sum
      : sum + asSafeInteger(
        row.nonpositive_cost_lines_excluded,
        "nonpositive_cost_lines_excluded",
      ),
    0,
  );
  const targets = result.rows
    .map(rowTarget)
    .filter((target) => !excluded.has(target.vendorId));
  const summary = {
    targetCount: targets.length,
    mappingsToCreate: targets.filter((target) => target.action === "create_mapping").length,
    mappingsToUpdate: targets.filter((target) =>
      target.action === "update_purchase_evidence"
    ).length,
    mappingsUnchanged: targets.filter((target) =>
      target.action === "unchanged" || target.action === "link_lines"
    ).length,
    linesToLink: targets.reduce((sum, target) => sum + target.linesToLink.length, 0),
    conflictingLines: targets.reduce(
      (sum, target) => sum + target.conflictingLineIds.length,
      0,
    ),
    nonpositiveCostLinesExcluded,
  };
  return {
    mode: "preview",
    contractVersion: BACKFILL_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    previewHash: previewFingerprint(
      targets,
      excludedVendorIds,
      nonpositiveCostLinesExcluded,
    ),
    excludedVendorIds,
    summary,
    targets,
  };
}

export async function previewHistoricalPoSupplierEvidence(
  queryable: Queryable,
  options: { excludedVendorIds?: number[] } = {},
): Promise<HistoricalSupplierEvidencePreview> {
  return previewWithQueryable(queryable, options);
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

export async function applyHistoricalPoSupplierEvidence(input: {
  pool: Pool;
  actorId: string;
  expectedPreviewHash: string;
  excludedVendorIds?: number[];
}): Promise<HistoricalSupplierEvidenceApplyResult> {
  const actorId = input.actorId.trim();
  if (!actorId) throw new Error("actorId is required");
  if (!/^[0-9a-f]{64}$/.test(input.expectedPreviewHash)) {
    throw new Error("expectedPreviewHash must be a SHA-256 hash from preview");
  }

  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [BACKFILL_ADVISORY_LOCK]);
    await assertActor(client, actorId);
    const preview = await previewWithQueryable(client, {
      excludedVendorIds: input.excludedVendorIds,
    });
    if (preview.previewHash !== input.expectedPreviewHash) {
      throw new Error("Historical PO evidence changed after preview; run preview again");
    }
    let createdMappings = 0;
    let updatedMappings = 0;
    let linkedLines = 0;
    let unchangedTargets = 0;

    for (const target of preview.targets) {
      let vendorProductId = target.vendorProductId;
      let before: Record<string, unknown> | null = null;
      let after: Record<string, unknown> | null = null;
      let action: string | null = null;

      if (vendorProductId === null) {
        const inserted = await client.query(
          `INSERT INTO procurement.vendor_products (
             vendor_id, product_id, product_variant_id,
             unit_cost_cents, unit_cost_mills, pricing_basis,
             purchase_uom, quoted_unit_cost_mills, pieces_per_purchase_uom,
             quote_reference, quoted_at, quote_valid_until,
             pack_size, moq, lead_time_days,
             is_preferred, is_active,
             last_purchased_at, last_cost_mills, last_cost_cents
           ) VALUES (
             $1, $2, $3,
             $4, $5, 'legacy_unknown',
             NULL, NULL, NULL,
             NULL, NULL, NULL,
             1, 1, NULL,
             0, 1, $6, $5, $4
           )
           ON CONFLICT (
             vendor_id, product_id, (COALESCE(product_variant_id, 0))
           ) DO NOTHING
           RETURNING *`,
          [
            target.vendorId,
            target.productId,
            target.productVariantId,
            target.lastCostCents,
            target.lastCostMills,
            target.sourceCompletedAt,
          ],
        );
        const row = inserted.rows[0];
        if (!row) {
          throw new Error(
            "Supplier mapping changed during apply; roll back and run preview again",
          );
        }
        vendorProductId = asSafeInteger(row.id, "vendor_product_id");
        after = row;
        action = "vendor_catalog.historical_purchase_mapping_created";
        createdMappings++;
      } else if (target.action === "update_purchase_evidence") {
        const current = await client.query(
          "SELECT * FROM procurement.vendor_products WHERE id = $1 FOR UPDATE",
          [vendorProductId],
        );
        before = current.rows[0] ?? null;
        const updated = await client.query(
          `UPDATE procurement.vendor_products
           SET last_purchased_at = $2,
               last_cost_mills = $3,
               last_cost_cents = $4,
               updated_at = GREATEST(updated_at, transaction_timestamp())
           WHERE id = $1
             AND (
               last_purchased_at IS NULL
               OR last_purchased_at < $2
               OR (
                 last_purchased_at = $2
                 AND (
                   last_cost_mills IS DISTINCT FROM $3
                   OR last_cost_cents IS DISTINCT FROM $4
                 )
               )
             )
           RETURNING *`,
          [
            vendorProductId,
            target.sourceCompletedAt,
            target.lastCostMills,
            target.lastCostCents,
          ],
        );
        after = updated.rows[0] ?? before;
        action = updated.rowCount === 1
          ? "vendor_catalog.purchase_evidence_backfilled"
          : null;
        if (updated.rowCount === 1) updatedMappings++;
      }

      const linkResult = await client.query(
        `UPDATE procurement.purchase_order_lines
         SET vendor_product_id = $1,
             updated_at = GREATEST(updated_at, transaction_timestamp())
         WHERE id = ANY($2::int[])
           AND vendor_product_id IS NULL`,
        [vendorProductId, target.linesToLink],
      );
      linkedLines += linkResult.rowCount ?? 0;
      if (!action && (linkResult.rowCount ?? 0) > 0) {
        action = "vendor_catalog.historical_po_lines_linked";
      }

      if (action) {
        await client.query(
          `INSERT INTO public.audit_events (
             level, actor, action, target, changes, context
           ) VALUES (
             'AUDIT', $1, $2, $3, $4::jsonb, $5::jsonb
           )`,
          [
            `user:${actorId}`,
            action,
            `vendor_product:${vendorProductId}`,
            JSON.stringify({ before, after }),
            JSON.stringify({
              contractVersion: BACKFILL_CONTRACT_VERSION,
              source: "historical_completed_purchase_orders",
              vendorProductId,
              vendorId: target.vendorId,
              productId: target.productId,
              productVariantId: target.productVariantId,
              sourcePurchaseOrderId: target.sourcePurchaseOrderId,
              sourcePoNumber: target.sourcePoNumber,
              sourceLineIds: target.sourceLineIds,
              linkedLineIds: target.linesToLink,
              conflictingLineIds: target.conflictingLineIds,
              excludedVendorIds: preview.excludedVendorIds,
              nonpositiveCostLinesExcluded:
                preview.summary.nonpositiveCostLinesExcluded,
              lastCostMills: target.lastCostMills,
              lastCostCents: target.lastCostCents,
              lastPurchasedAt: target.sourceCompletedAt,
            }),
          ],
        );
      }

      if (!action && (linkResult.rowCount ?? 0) === 0) unchangedTargets++;
    }

    await client.query("COMMIT");
    return {
      mode: "apply",
      contractVersion: BACKFILL_CONTRACT_VERSION,
      previewHash: preview.previewHash,
      actorId,
      excludedVendorIds: preview.excludedVendorIds,
      createdMappings,
      updatedMappings,
      linkedLines,
      conflictingLinesSkipped: preview.summary.conflictingLines,
      nonpositiveCostLinesExcluded:
        preview.summary.nonpositiveCostLinesExcluded,
      unchangedTargets,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
