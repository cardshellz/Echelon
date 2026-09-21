import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { sqlIntegerArray } from "../../infrastructure/postgres-array";
import { projectPersistedDeclaredPackageLifecycleShadow } from "../shipping/declared-package-lifecycle-shadow.domain";
import { decideEbayLabelReplacement } from "./ebay-label-replacement.domain";
import {
  MAX_LABEL_REPLACEMENT_CANDIDATES,
  MAX_LABEL_REPLACEMENT_ITEMS,
  scopeLabelReplacementPredecessors,
} from "./label-replacement-scope.domain";
import { enqueueShopifyLabelVoids } from "./shopify-label-void-intake.repository";
import type { MaterializePhysicalPackageInput, MaterializePhysicalPackageResult } from "./channel-fulfillment-authority.repository";

type Transaction = { execute(query: ReturnType<typeof sql>): Promise<unknown> };
export type EbayLabelReplacementResult =
  | { readonly outcome: "waiting" | "review" | "skipped"; readonly reason: string }
  | { readonly outcome: "applied"; readonly materialized: MaterializePhysicalPackageResult };
export interface AuthorizedLabelReplacement {
  /** Only Shopify package correction admission may authorize a source portion.
   * Omitted for eBay, whose whole-source contract remains unchanged. */
  readonly shopifyPackageScope?: true;
  readonly labelId: number;
  readonly sourceItemIds: readonly number[];
  readonly sourceItems: readonly { readonly sourceShipmentItemId: number; readonly quantity: number }[];
}

function rows<T>(result: unknown): T[] {
  const value = result as { rows?: T[] };
  if (!Array.isArray(value.rows)) throw new Error("Label replacement query returned no row collection");
  return value.rows;
}

interface PreviousItem {
  id: string; physical_shipment_id: string; source_id: number; quantity_shipped: number;
  label_id: string;
  label_status: "active" | "voided" | "superseded" | "unknown";
  carrier_possession: boolean; tracking_number: string;
  provider_order_id: string | null;
}

/** Runs inside the canonical owner's transaction. Original allocation plans and
 * physical evidence remain immutable; the existing effective-quantity ledger
 * records a conserving transfer. No inventory or provider calls occur here. */
export async function reconcileEbayLabelReplacement(
  tx: Transaction,
  labelId: number,
  now: Date,
  materialize: (input: MaterializePhysicalPackageInput, authority: AuthorizedLabelReplacement) => Promise<MaterializePhysicalPackageResult>,
): Promise<EbayLabelReplacementResult | null> {
  if (!Number.isSafeInteger(labelId) || labelId <= 0 || !Number.isFinite(now.getTime())) throw new Error("Invalid label replacement identity or clock");
  // Applied identity is immutable. Finish a pending projection even if this
  // label was subsequently voided; command claiming separately rejects voids.
  const applied = rows<{ physical_shipment_id: string }>(await tx.execute(sql`
    SELECT physical_shipment_id FROM wms.ebay_label_replacement_work
    WHERE shipping_provider_label_id = ${labelId} AND state = 'applied'`))[0];
  if (applied) return { outcome: "applied", materialized: await readLabelReplacementMaterialization(tx, Number(applied.physical_shipment_id)) };
  const { label, events, lifecycle } = await readLabelEvidence(tx, labelId);
  if (!label || label.label_direction !== "outbound") return null;
  if (label.label_status === "voided" || label.label_status === "superseded") {
    await tx.execute(sql`UPDATE wms.ebay_label_replacement_work SET state = 'review', reason = 'replacement_label_inactive', updated_at = ${now}
      WHERE shipping_provider_label_id = ${labelId} AND state = 'waiting'`);
    return { outcome: "skipped", reason: "inactive_label" };
  }
  if (!lifecycle || lifecycle.outcome !== "projected" || lifecycle.projection.contentsStatus !== "authoritative"
    || lifecycle.projection.reconciliationStatus !== "clear" || lifecycle.projection.labelStatus !== "active") {
    return null; // Existing allocation owner records rejected evidence for review.
  }
  const contents = lifecycle.projection.authoritativeContents?.map(item => ({ sourceShipmentItemId: item.wmsShipmentItemId, quantity: item.quantity }));
  if (!contents) return null;
  const sourceIds = contents.map(item => item.sourceShipmentItemId);
  // Shared source locks serialize different labels even when their provider order IDs differ.
  const sources = rows<{ id: number; shipment_id: number; qty: number; provider: string; purpose: string }>(await tx.execute(sql`
    SELECT item.id, item.shipment_id, item.qty, channel.provider, item.shipment_item_purpose AS purpose
    FROM wms.outbound_shipment_items item
    JOIN wms.order_items order_item ON order_item.id = item.order_item_id
    JOIN oms.oms_order_lines line ON line.id = order_item.oms_order_line_id
    JOIN oms.oms_orders orders ON orders.id = line.order_id
    JOIN channels.channels channel ON channel.id = orders.channel_id
    WHERE item.id IN (${sql.join(sourceIds.map(id => sql`${id}`), sql`, `)}) ORDER BY item.id`));
  const shopifyPackageScope = sources.length > 0 && sources.every(item => item.provider === "shopify");
  if (sources.length !== sourceIds.length || sources.some(item => item.purpose !== "customer_fulfillment")
    || (!shopifyPackageScope && sources.some(item => item.provider !== "ebay"))) return null;
  await tx.execute(sql`SELECT id FROM wms.outbound_shipment_items WHERE id IN (
    ${sql.join(sourceIds.map(id => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
  const locked = await readLabelEvidence(tx, labelId, true);
  if (JSON.stringify(locked.label) !== JSON.stringify(label)
    || JSON.stringify(locked.events) !== JSON.stringify(events)) throw new Error("Label evidence changed during replacement admission; retry required");

  const concurrentApplication = rows<{ physical_shipment_id: string }>(await tx.execute(sql`
    SELECT physical_shipment_id FROM wms.ebay_label_replacement_work
    WHERE shipping_provider_label_id = ${labelId} AND state = 'applied'`))[0];
  if (concurrentApplication) return { outcome: "applied", materialized: await readLabelReplacementMaterialization(tx, Number(concurrentApplication.physical_shipment_id)) };

  const allocated = rows<PreviousItem>(await tx.execute(sql`
    SELECT item.id, item.physical_shipment_id, item.quantity_shipped,
      COALESCE(item.legacy_wms_shipment_item_id, item.label_replacement_source_item_id, source.source_wms_shipment_item_id) AS source_id,
      old_label.id AS label_id, COALESCE(old_label.label_status, 'unknown') AS label_status, package.tracking_number,
      old_label.provider_order_id,
      EXISTS (SELECT 1 FROM wms.carrier_tracking_event_matches match
        JOIN wms.carrier_tracking_events event ON event.id = match.carrier_tracking_event_id
        WHERE match.shipping_provider_label_id = old_label.id AND event.dispatch_evidence = 'confirmed'
          AND match.match_status IN ('matched', 'voided_label')) AS carrier_possession
    FROM wms.effective_physical_shipment_items item
    JOIN wms.physical_shipments package ON package.id = item.physical_shipment_id
    LEFT JOIN wms.package_allocation_entries entry ON entry.id = item.package_allocation_entry_id
    LEFT JOIN wms.package_allocation_source_lines source ON source.id = entry.package_allocation_source_line_id
    LEFT JOIN wms.shipping_provider_labels old_label ON old_label.provider = package.provider
      AND old_label.provider_label_id = package.provider_physical_shipment_id
    WHERE COALESCE(item.legacy_wms_shipment_item_id, item.label_replacement_source_item_id, source.source_wms_shipment_item_id)
      IN (${sql.join(sourceIds.map(id => sql`${id}`), sql`, `)})
      AND NOT (package.provider = 'shipstation' AND package.provider_physical_shipment_id = ${label.provider_label_id})
    ORDER BY item.id LIMIT ${MAX_LABEL_REPLACEMENT_ITEMS + 1}`));
  async function defer(state: "waiting" | "review", reason: string): Promise<EbayLabelReplacementResult> {
    await tx.execute(sql`INSERT INTO wms.ebay_label_replacement_work
      (shipping_provider_label_id, state, reason, source_item_ids, created_at, updated_at)
      VALUES (${labelId}, ${state}, ${reason}, ${sqlIntegerArray(sourceIds)}, ${now}, ${now})
      ON CONFLICT (shipping_provider_label_id) DO UPDATE SET state = EXCLUDED.state,
        reason = EXCLUDED.reason, updated_at = EXCLUDED.updated_at
      WHERE ebay_label_replacement_work.state <> 'applied'`);
    return { outcome: state, reason };
  }
  if (allocated.length > MAX_LABEL_REPLACEMENT_ITEMS) return defer("review", "replacement_candidate_limit_exceeded");
  if (allocated.length === 0) return null;
  const scopeInput = allocated.map(item => ({
    physicalItemId: Number(item.id), physicalShipmentId: Number(item.physical_shipment_id),
    sourceItemId: Number(item.source_id), providerOrderId: item.provider_order_id, labelStatus: item.label_status,
  }));
  const scope = scopeLabelReplacementPredecessors({ providerOrderId: label.provider_order_id, sourceItemIds: sourceIds, previous: scopeInput });
  if (scope.outcome === "review") return defer("review", scope.reason);
  const priorIds = new Set(scope.physicalItemIds);
  const prior = allocated.filter(item => priorIds.has(Number(item.id)));
  if (shopifyPackageScope && prior.every(item => item.label_status !== "voided") && contents.every(content => {
    const existing = allocated.filter(item => Number(item.source_id) === content.sourceShipmentItemId)
      .reduce((sum, item) => sum + Number(item.quantity_shipped), 0);
    return Number.isSafeInteger(existing) && existing + content.quantity <= Number(sources.find(item => item.id === content.sourceShipmentItemId)?.qty);
  })) return null; // An additional package fits without transferring anyone else's units.
  const decision = decideEbayLabelReplacement({
    contents: contents.map(item => ({ sourceItemId: item.sourceShipmentItemId, quantity: item.quantity })),
    previous: prior.map(item => ({ sourceItemId: Number(item.source_id), quantity: Number(item.quantity_shipped),
      physicalItemId: Number(item.id), labelStatus: item.label_status, carrierPossession: item.carrier_possession })),
  });
  if (sources.some(item => shopifyPackageScope
    ? Number(item.qty) < Number(contents.find(content => content.sourceShipmentItemId === item.id)?.quantity)
    : Number(item.qty) !== contents.find(content => content.sourceShipmentItemId === item.id)?.quantity)) {
    return defer("review", "partial_source_replacement_requires_allocation_plan");
  }
  if (decision.outcome !== "transfer") return defer(decision.outcome, decision.reason);
  // A mutable label status alone is not void authority. Reuse the lifecycle
  // projector's hash, event ordering, direction and exact-content validation.
  for (const oldLabelId of [...new Set(prior.map(item => Number(item.label_id)))].sort((a, b) => a - b)) {
    const old = await readLabelEvidence(tx, oldLabelId, true);
    if (old.lifecycle?.outcome !== "projected" || old.lifecycle.projection.labelStatus !== "voided"
      || old.lifecycle.projection.correctionStatus !== "awaiting_relabel"
      || old.lifecycle.projection.contentsStatus !== "authoritative") return defer("review", "predecessor_void_evidence_unproven");
    const expected = prior.filter(item => Number(item.label_id) === oldLabelId)
      .map(item => ({ wmsShipmentItemId: Number(item.source_id), quantity: Number(item.quantity_shipped) }))
      .sort((a, b) => a.wmsShipmentItemId - b.wmsShipmentItemId);
    if (JSON.stringify(old.lifecycle.projection.authoritativeContents) !== JSON.stringify(expected)) {
      return defer("review", "predecessor_contents_do_not_match_allocation");
    }
  }
  const candidates = rows<{ id: string }>(await tx.execute(sql`
    SELECT DISTINCT label.id FROM wms.shipping_provider_labels label
    JOIN wms.shipping_provider_label_links link ON link.shipping_provider_label_id = label.id
    WHERE label.provider = 'shipstation' AND label.label_status = 'active' AND label.id <> ${labelId}
      AND link.legacy_wms_shipment_id IN (${sql.join(sources.map(item => sql`${item.shipment_id}`), sql`, `)})
      AND NOT EXISTS (SELECT 1 FROM wms.physical_shipments known_package
        WHERE known_package.provider = label.provider AND known_package.provider_physical_shipment_id = label.provider_label_id)
    ORDER BY label.id LIMIT ${MAX_LABEL_REPLACEMENT_CANDIDATES + 1}`));
  if (candidates.length > MAX_LABEL_REPLACEMENT_CANDIDATES) return defer("review", "replacement_candidate_limit_exceeded");
  for (const candidate of candidates) {
    // The WMS header only discovers related evidence. Competition means two
    // labels claim the SAME old physical allocation, not merely the same order.
    const evidence = await readLabelEvidence(tx, Number(candidate.id));
    if (!evidence.label || evidence.label.label_direction === "return" || evidence.label.label_status !== "active") continue;
    if (evidence.lifecycle?.outcome !== "projected" || evidence.lifecycle.projection.contentsStatus !== "authoritative"
      || evidence.lifecycle.projection.reconciliationStatus !== "clear") return defer("review", "competing_replacement_evidence_unproven");
    const competingScope = scopeLabelReplacementPredecessors({ providerOrderId: evidence.label.provider_order_id,
      sourceItemIds: evidence.lifecycle.projection.authoritativeContents!.map(item => item.wmsShipmentItemId), previous: scopeInput });
    if (competingScope.outcome === "review") return defer("review", competingScope.reason);
    if (competingScope.physicalItemIds.some(id => priorIds.has(id))) return defer("review", "multiple_active_replacement_candidates");
  }
  const priorPackageIds = [...new Set(prior.map(item => Number(item.physical_shipment_id)))];
  const allPriorItems = rows<{ id: string }>(await tx.execute(sql`SELECT id FROM wms.effective_physical_shipment_items
    WHERE physical_shipment_id IN (${sql.join(priorPackageIds.map(id => sql`${id}`), sql`, `)})`));
  if (allPriorItems.length !== prior.length) return defer("review", "replacement_does_not_cover_previous_packages");
  // A command already in flight must finish before we supersede its allocation.
  const previousCommands = rows<{ id: number; push_status: string }>(await tx.execute(sql`
    SELECT id, push_status FROM oms.channel_fulfillment_pushes
    WHERE physical_shipment_id IN (${sql.join(priorPackageIds.map(id => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`));
  if (previousCommands.some(command => command.push_status === "processing")) return defer("waiting", "previous_channel_command_processing");
  if (shopifyPackageScope) {
    for (const oldLabelId of [...new Set(prior.map(item => Number(item.label_id)))]) await enqueueShopifyLabelVoids(tx, oldLabelId, now);
    const corrections = rows<{ state: string }>(await tx.execute(sql`SELECT work.state FROM oms.shopify_label_void_work work
      WHERE work.physical_shipment_id IN (${sql.join(priorPackageIds.map(id => sql`${id}`), sql`, `)})`));
    if (corrections.some(work => work.state === 'review')) return defer('review', 'shopify_predecessor_void_requires_review');
    if (corrections.length === 0) return defer('review', 'shopify_predecessor_command_missing');
    if (corrections.some(work => work.state !== 'complete')) return defer('waiting', 'shopify_predecessor_void_pending');
  }
  const payload = events[0].sanitized_payload;
  const carrier = typeof payload.carrierCode === "string" ? payload.carrierCode.trim() : "";
  if (!carrier || !label.tracking_number || (!label.provider_order_id && !label.provider_order_key)) return defer("review", "replacement_provider_identity_missing");
  await defer("waiting", "materializing_replacement");
  const operationHash = createHash("sha256").update(`shipstation-label-replacement:${labelId}`).digest("hex");
  const operationId = `${operationHash.slice(0, 8)}-${operationHash.slice(8, 12)}-${operationHash.slice(12, 16)}-${operationHash.slice(16, 20)}-${operationHash.slice(20, 32)}`;
  for (const previous of prior) {
    await tx.execute(sql`INSERT INTO wms.physical_shipment_item_quantity_adjustments
      (physical_shipment_item_id, quantity_delta, adjustment_kind, repair_run_id, idempotency_key, operator, reason, metadata, created_at)
      VALUES (${Number(previous.id)}, ${-Number(previous.quantity_shipped)}, 'provider_label_replacement', ${operationId}::uuid,
        ${`label-replacement:${labelId}:${previous.id}`}, 'system:shipstation_label_replacement',
        'Transfer unchanged commercial quantity from a voided label to its exact replacement',
        ${JSON.stringify({ matchingContract: "package-lineage-v1", replacementLabelId: labelId,
          previousLabelId: Number(previous.label_id), previousPhysicalShipmentId: Number(previous.physical_shipment_id),
          previousProviderOrderId: previous.provider_order_id, replacementProviderOrderId: label.provider_order_id,
          sourceItemId: previous.source_id, previousTrackingNumber: previous.tracking_number })}::jsonb, ${now})`);
  }
  await tx.execute(sql`UPDATE oms.channel_fulfillment_pushes SET push_status = 'review',
    last_error_code = 'PACKAGE_LABEL_SUPERSEDED', last_error = 'A verified void/relabel transition superseded this pending package', updated_at = ${now}
    WHERE physical_shipment_id IN (${sql.join(priorPackageIds.map(id => sql`${id}`), sql`, `)}) AND push_status IN ('pending', 'retry')`);
  const materialized = await materialize({
    legacyWmsShipmentIds: [...new Set(sources.map(item => item.shipment_id))], shippingProvider: "shipstation",
    providerPhysicalShipmentId: label.provider_label_id, providerOrderId: label.provider_order_id,
    providerOrderKey: label.provider_order_key, trackingNumber: label.tracking_number, carrier,
    shippedAt: new Date(events[0].received_at), source: "shipstation_label_replacement", legacyHeaderPolicy: "aggregate_projection",
    correlationId: `shipping-provider-label:${labelId}`,
  }, { labelId, sourceItemIds: sourceIds, sourceItems: contents, ...(shopifyPackageScope ? { shopifyPackageScope: true as const } : {}) });
  await tx.execute(sql`UPDATE wms.ebay_label_replacement_work SET state = 'applied', reason = NULL,
    physical_shipment_id = ${materialized.physicalShipmentId}, updated_at = ${now} WHERE shipping_provider_label_id = ${labelId}`);
  return { outcome: "applied", materialized };
}

export async function readLabelReplacementMaterialization(tx: Transaction, physicalShipmentId: number): Promise<MaterializePhysicalPackageResult> {
  const packages = rows<{ shipping_engine_order_id: string; item_count: number }>(await tx.execute(sql`
    SELECT package.shipping_engine_order_id, COUNT(item.id)::int AS item_count FROM wms.physical_shipments package
    JOIN wms.physical_shipment_items item ON item.physical_shipment_id = package.id
    WHERE package.id = ${physicalShipmentId} GROUP BY package.id`));
  if (packages.length !== 1) throw new Error("Applied label replacement has no canonical package");
  const commands = rows<{ id: number; command_key: string; push_status: string }>(await tx.execute(sql`
    SELECT id, command_key, push_status FROM oms.channel_fulfillment_pushes WHERE physical_shipment_id = ${physicalShipmentId} ORDER BY id`));
  return { physicalShipmentId, shippingEngineOrderId: Number(packages[0].shipping_engine_order_id),
    customerFulfillmentItemCount: packages[0].item_count, nonCustomerItemCount: 0,
    channelCommands: commands.map(command => ({ id: Number(command.id), commandKey: command.command_key, pushStatus: command.push_status, replayed: true })) };
}

interface LabelEvidenceRow {
  id: string; provider_label_id: string; provider_order_id: string | null; provider_order_key: string | null;
  tracking_number: string; label_status: "active" | "voided" | "superseded" | "unknown"; label_direction: string;
  first_observed_at: Date; last_observed_at: Date;
}
interface LabelEventRow {
  id: string; event_hash: string; event_type: string; label_status: string; tracking_number: string;
  provider_occurred_at: Date | null; received_at: Date; sanitized_payload: Record<string, unknown>;
}
export async function readLabelEvidence(tx: Transaction, labelId: number, lock = false) {
  const label = rows<LabelEvidenceRow>(await tx.execute(sql`SELECT id, provider_label_id, provider_order_id, provider_order_key,
    tracking_number, label_status, label_direction, first_observed_at, last_observed_at FROM wms.shipping_provider_labels
    WHERE id = ${labelId} AND provider = 'shipstation' ${lock ? sql`FOR UPDATE` : sql``}`))[0];
  if (!label) return { label: null, events: [], lifecycle: null };
  const events = rows<LabelEventRow>(await tx.execute(sql`SELECT id, event_hash, event_type, label_status, tracking_number,
    provider_occurred_at, received_at, sanitized_payload FROM wms.shipping_provider_label_events
    WHERE shipping_provider_label_id = ${labelId} ORDER BY received_at DESC, id DESC LIMIT 501`));
  if (events.length > 500) return { label, events: [], lifecycle: null };
  const lifecycle = projectPersistedDeclaredPackageLifecycleShadow({
    shippingProviderLabelId: labelId, provider: "shipstation", providerPhysicalShipmentId: label.provider_label_id,
    currentTrackingNumber: label.tracking_number, currentLabelStatus: label.label_status,
    firstObservedAt: new Date(label.first_observed_at), lastObservedAt: new Date(label.last_observed_at), labelDirection: label.label_direction,
    labelEvents: events.map(event => ({ id: Number(event.id), shippingProviderLabelId: labelId,
      eventHash: event.event_hash, eventType: event.event_type, labelStatus: event.label_status,
      trackingNumber: event.tracking_number, providerOccurredAt: event.provider_occurred_at == null ? null : new Date(event.provider_occurred_at),
      sanitizedPayload: event.sanitized_payload, receivedAt: new Date(event.received_at) })),
    // Predecessor carrier evidence is checked independently against all confirmed
    // matches, conservatively including matches later superseded by reconciliation.
    confirmedCarrierEvents: [],
  });
  return { label, events, lifecycle };
}
