import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { sqlIntegerArray } from "../../infrastructure/postgres-array";
import { readLabelEvidence, readPreviousItems, readSources,
  type AuthorizedLabelReplacement, type PreviousItem, type SourceItem } from "./ebay-label-replacement.repository";
import { planPackageReconciliation, packageReconciliationInputSchema, type PackageReconciliationInput, type PackageReconciliationPlan } from "./package-reconciliation.domain";
import type { MaterializePhysicalPackageInput, MaterializePhysicalPackageResult } from "./channel-fulfillment-authority.repository";

type Transaction = { execute(query: ReturnType<typeof sql>): Promise<unknown> };
type Evidence = Awaited<ReturnType<typeof readLabelEvidence>>;
const integer = z.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const contents = z.array(z.object({ sourceItemId: integer, quantity: z.number().int().positive().max(2_147_483_647) }).strict()).max(500);
export const packageProviderProofSchema = z.object({
  labels: z.array(z.object({ labelId: integer, providerLabelId: z.string().min(1).max(200), providerOrderId: z.string().min(1).max(200),
    providerOrderKey: z.string().max(200).nullable(), trackingNumber: z.string().min(1).max(200), carrier: z.string().min(1).max(100),
    serviceCode: z.string().max(100).nullable(), outbound: z.literal(true), status: z.enum(["active", "voided"]), contents,
    evidenceHash: hash }).strict()).min(1).max(100),
  relationships: packageReconciliationInputSchema.shape.relationships,
  // A server-side authenticated provider reader supplies this proof; it is not
  // accepted directly from an HTTP request or an operator-authored manifest.
  observedAt: z.string().datetime(),
}).strict();
export type PackageProviderProof = z.infer<typeof packageProviderProofSchema>;
export interface PackageReconciliationSnapshot {
  readonly sourceIds: readonly number[];
  readonly sources: readonly SourceItem[];
  readonly previous: readonly PreviousItem[];
  readonly evidence: readonly Evidence[];
  readonly input: PackageReconciliationInput;
  readonly hash: string;
}
export const packageReconciliationCommandSchema = z.object({
  commandKey: z.string().trim().min(1).max(200), expectedSnapshotHash: hash, expectedPlanHash: hash,
  sourceItemIds: z.array(integer).min(1).max(500), actor: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(500),
  mode: z.enum(["live", "adopt_existing"]), correction: packageReconciliationInputSchema.shape.correction,
  providerProof: packageProviderProofSchema.nullable(),
}).strict();
export type PackageReconciliationCommand = z.input<typeof packageReconciliationCommandSchema>;
export interface PackageReconciliationResult {
  readonly commandId: number;
  readonly operationId: string;
  readonly evidenceHash: string;
  readonly physicalShipmentIds: readonly number[];
  readonly channelCommandIds: readonly number[];
  readonly sourceItemIds: readonly number[];
  readonly omsOrderIds: readonly number[];
  readonly correctedPreviousLabelIds: readonly number[];
  readonly replayed: boolean;
}
export class PackageReconciliationError extends Error {
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {}) { super(message); this.name = "PackageReconciliationError"; }
}
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
function rows<T>(result: unknown): T[] {
  const value = result as { rows?: T[] };
  if (!Array.isArray(value.rows)) throw new PackageReconciliationError("INVALID_DATABASE_RESULT", "Package reconciliation query returned no row collection");
  return value.rows;
}
function databaseId(value: unknown, field: string): number {
  const parsed=integer.safeParse(typeof value==='string'&&/^[1-9]\d*$/.test(value)?Number(value):value);
  if(!parsed.success)throw new PackageReconciliationError('INVALID_DATABASE_ID',`Invalid or unsafe database identity: ${field}`);
  return parsed.data;
}

/** Discover complete physical packages and every persisted label sharing their
 * original sources. Never materialize a caller-selected partial package graph. */
export async function loadPackageReconciliationSnapshot(tx: Transaction, rawSourceIds: readonly number[], lock = false): Promise<PackageReconciliationSnapshot> {
  const seed = z.array(integer).min(1).max(500).parse(rawSourceIds);
  const sourceIds = new Set(seed);
  const evidenceById = new Map<number, Evidence>();
  let previous: PreviousItem[] = [];
  let sources: SourceItem[] = [];
  let complete = false;
  for (let round = 0; round < 20; round++) {
    const priorSize = sourceIds.size + evidenceById.size;
    sources = await readSources(tx, [...sourceIds].sort((a, b) => a - b));
    if (sources.length !== sourceIds.size || sources.some(source => source.purpose !== "customer_fulfillment")) {
      throw new PackageReconciliationError("SOURCE_SCOPE_UNPROVEN", "Every source must be an exact supported customer fulfillment line");
    }
    if (lock) await tx.execute(sql`SELECT id FROM wms.outbound_shipment_items WHERE id = ANY(${sqlIntegerArray([...sourceIds].sort((a, b) => a - b))}) ORDER BY id FOR UPDATE`);
    previous = await readPreviousItems(tx, [...sourceIds], "");
    if (previous.length > 500) throw new PackageReconciliationError("PACKAGE_SCOPE_LIMIT", "Physical package graph exceeds the reconciliation bound");
    for (const item of previous) sourceIds.add(Number(item.source_id));
    const selected = rows<{ id: string }>(await tx.execute(sql`
      SELECT DISTINCT label.id FROM wms.shipping_provider_labels label
      LEFT JOIN wms.shipping_provider_label_links link ON link.shipping_provider_label_id = label.id
      WHERE label.provider = 'shipstation' AND (
        link.legacy_wms_shipment_id = ANY(${sqlIntegerArray(sources.map(source => source.shipment_id))})
        OR label.id = ANY(${sqlIntegerArray(previous.map(item => Number(item.label_id)))}))
      ORDER BY label.id LIMIT 101`));
    if (selected.length > 100) throw new PackageReconciliationError("PACKAGE_SCOPE_LIMIT", "Related labels exceed the reconciliation bound");
    for (const row of selected) {
      const labelId = Number(row.id);
      if (!evidenceById.has(labelId)) evidenceById.set(labelId, await readLabelEvidence(tx, labelId, lock));
    }
    for (const evidence of evidenceById.values()) {
      if (evidence.label?.label_status !== "active" || evidence.lifecycle?.outcome !== "projected") continue;
      for (const line of evidence.lifecycle.projection.authoritativeContents ?? []) sourceIds.add(line.wmsShipmentItemId);
    }
    if (sourceIds.size > 500) throw new PackageReconciliationError("PACKAGE_SCOPE_LIMIT", "Source graph exceeds the reconciliation bound");
    if (sourceIds.size + evidenceById.size === priorSize) { complete = true; break; }
  }
  if (!complete || evidenceById.size === 0) throw new PackageReconciliationError("PACKAGE_SCOPE_UNPROVEN", "Package relationship discovery did not converge");
  const evidence = [...evidenceById].sort(([a], [b]) => a - b).map(([, value]) => value);
  const input: PackageReconciliationInput = {
    sources: sources.map(source => ({ sourceItemId: source.id, quantity: source.qty })),
    labels: evidence.map(item => {
      if (!item.label?.provider_order_id) throw new PackageReconciliationError("PROVIDER_IDENTITY_MISSING", "A label lacks its exact provider order");
      const projected = item.lifecycle?.outcome === "projected" ? item.lifecycle.projection : null;
      const carrierPossession = previous.some(old => String(old.label_id) === item.label!.id && old.carrier_possession);
      return { labelId: Number(item.label.id), providerOrderId: item.label.provider_order_id, trackingNumber: item.label.tracking_number,
        status: item.label.label_status, outbound: item.label.label_direction === "outbound", carrierPossession,
        contentsVerified: projected?.contentsStatus === "authoritative" && projected.reconciliationStatus === "clear",
        voidVerified: projected?.labelStatus === "voided" && projected.correctionStatus === "awaiting_relabel",
        contents: (projected?.authoritativeContents ?? []).map(line => ({ sourceItemId: line.wmsShipmentItemId, quantity: line.quantity })) };
    }),
    previous: previous.map(item => ({ physicalItemId: Number(item.id), physicalShipmentId: Number(item.physical_shipment_id),
      labelId: Number(item.label_id), sourceItemId: item.source_id, quantity: item.quantity_shipped })), relationships: [], correction: null,
  };
  // Mutable observation timestamps alone cannot invalidate a reviewed plan.
  // Label/event hashes, source capacities and effective allocations can.
  const snapshotHash = digest({ input, sourceIdentities:sources, events: evidence.map(item => ({ label: item.label ? { id: item.label.id, providerLabelId: item.label.provider_label_id,
    providerOrderId: item.label.provider_order_id, providerOrderKey: item.label.provider_order_key,
    tracking: item.label.tracking_number, status: item.label.label_status, direction: item.label.label_direction } : null,
    events: item.events.map(event => ({ id: event.id, hash: event.event_hash })) })) });
  return { sourceIds: [...sourceIds].sort((a, b) => a - b), sources, previous, evidence, input, hash: snapshotHash };
}

export function packageReconciliationInputFromProof(snapshot: PackageReconciliationSnapshot,
  providerProof: PackageProviderProof | null, correction: PackageReconciliationInput["correction"]): PackageReconciliationInput {
  const input = structuredClone(snapshot.input);
  input.correction = correction ?? null;
  if (!providerProof) return input;
  const proof = packageProviderProofSchema.parse(providerProof);
  if (proof.labels.length !== input.labels.length || new Set(proof.labels.map(item => item.labelId)).size !== proof.labels.length) {
    throw new PackageReconciliationError("PROVIDER_SCOPE_CHANGED", "Provider proof does not cover the complete label snapshot");
  }
  input.labels = input.labels.map(label => {
    const observed = proof.labels.find(item => item.labelId === label.labelId);
    const persisted = snapshot.evidence.find(item => Number(item.label?.id) === label.labelId)?.label;
    if (!observed || !persisted || observed.providerLabelId !== persisted.provider_label_id
      || observed.providerOrderId !== persisted.provider_order_id || observed.providerOrderKey !== persisted.provider_order_key
      || observed.trackingNumber !== persisted.tracking_number || observed.status !== persisted.label_status
      || persisted.label_direction !== "outbound") throw new PackageReconciliationError("PROVIDER_IDENTITY_CHANGED", "Exact provider label identity differs from the locked snapshot", { labelId: label.labelId });
    if (observed.contents.some(line => !snapshot.sourceIds.includes(line.sourceItemId))) throw new PackageReconciliationError("PROVIDER_SCOPE_CHANGED", "Provider proof introduced an undiscovered source");
    return { ...label, contents: observed.contents, contentsVerified: true, voidVerified: observed.status === "voided" };
  });
  input.relationships = proof.relationships;
  return packageReconciliationInputSchema.parse(input);
}

export async function applyPackageReconciliation(tx: Transaction, rawCommand: PackageReconciliationCommand, now: Date,
  materialize: (input: MaterializePhysicalPackageInput, authority: AuthorizedLabelReplacement) => Promise<MaterializePhysicalPackageResult>,
): Promise<PackageReconciliationResult> {
  const command = packageReconciliationCommandSchema.parse(rawCommand);
  if (!Number.isFinite(now.getTime())) throw new PackageReconciliationError("INVALID_CLOCK", "Package reconciliation requires a valid injected clock");
  if (command.mode === "adopt_existing" || command.correction) {
    const principal = rows(await tx.execute(sql`SELECT id FROM identity.users WHERE id::text = ${command.actor} AND role = 'admin' AND active = 1`));
    if (principal.length !== 1) throw new PackageReconciliationError("OPERATOR_NOT_AUTHORIZED", "Package correction requires an active authenticated administrator");
    if (command.correction && command.correction.actorId !== command.actor) throw new PackageReconciliationError("OPERATOR_NOT_AUTHORIZED", "Correction actor differs from the authenticated command actor");
  }
  const requestHash = digest({ ...command, providerProof: command.providerProof ? { ...command.providerProof, observedAt: null } : null });
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`package-reconciliation:${command.commandKey}`}, 0))`);
  const replay = rows<{ id: string; request_hash: string; state: string; result: PackageReconciliationResult }>(await tx.execute(sql`
    SELECT id, request_hash, state, result FROM oms.package_reconciliation_commands WHERE command_key = ${command.commandKey} FOR UPDATE`))[0];
  if (replay) {
    if (replay.request_hash !== requestHash) throw new PackageReconciliationError("RECONCILIATION_REPLAY_CONFLICT", "The reconciliation command key was already used for different evidence");
    if (!replay.result || replay.state === "applying") throw new PackageReconciliationError("RECONCILIATION_INCOMPLETE", "A reconciliation command has no applied receipt");
    return { ...replay.result, replayed: true };
  }
  if (command.providerProof) {
    const age = now.getTime() - Date.parse(command.providerProof.observedAt);
    if (age < -30_000 || age > 5 * 60_000) throw new PackageReconciliationError("PROVIDER_PROOF_EXPIRED", "Refresh provider evidence before applying the reviewed plan");
  }
  const snapshot = await loadPackageReconciliationSnapshot(tx, command.sourceItemIds, true);
  if (snapshot.hash !== command.expectedSnapshotHash) throw new PackageReconciliationError("STALE_PACKAGE_SNAPSHOT", "Package allocations changed after the reviewed preview");
  const input = packageReconciliationInputFromProof(snapshot, command.providerProof, command.correction);
  const plan = planPackageReconciliation(input);
  if ((plan.outcome !== "ready" && plan.outcome !== "unchanged") || plan.evidenceHash !== command.expectedPlanHash) {
    throw new PackageReconciliationError("PACKAGE_PLAN_CHANGED", "The current package plan is not the reviewed conserving plan", { outcome: plan.outcome });
  }
  const operationHash = digest({ commandKey: command.commandKey, requestHash });
  const operationId = `${operationHash.slice(0, 8)}-${operationHash.slice(8, 12)}-${operationHash.slice(12, 16)}-${operationHash.slice(16, 20)}-${operationHash.slice(20, 32)}`;
  const inserted = rows<{ id: string }>(await tx.execute(sql`
    INSERT INTO oms.package_reconciliation_commands(command_key, request_hash, operation_id, actor, reason, mode, state, evidence, plan, created_at)
    VALUES (${command.commandKey}, ${requestHash}, ${operationId}::uuid, ${command.actor}, ${command.reason}, ${command.mode}, 'applying',
      ${JSON.stringify({ ...input, providerProof: command.providerProof, command })}::jsonb, ${JSON.stringify(plan)}::jsonb, ${now}) RETURNING id`))[0];
  if (!inserted) throw new PackageReconciliationError("RECEIPT_MISSING", "Reconciliation failed to reserve its immutable receipt");
  const commandId = databaseId(inserted.id,'package reconciliation command');
  const retired = snapshot.previous.filter(item => plan.physicalItemIdsToRetire.includes(Number(item.id)));
  const oldPackageIds = [...new Set(retired.map(item => Number(item.physical_shipment_id)))];
  const oldCommands = rows<{ push_status: string }>(await tx.execute(sql`SELECT push_status FROM oms.channel_fulfillment_pushes
    WHERE physical_shipment_id = ANY(${sqlIntegerArray(oldPackageIds)}) ORDER BY id FOR UPDATE`));
  if (oldCommands.some(item => item.push_status === "processing")) throw new PackageReconciliationError("CHANNEL_COMMAND_IN_PROGRESS", "An earlier package command must finish before its allocation can be reconciled");
  if (command.mode === "live" && snapshot.sources.some(source => source.provider === "shopify") && retired.length > 0) {
    const work = rows<{ physical_shipment_id: string; state: string }>(await tx.execute(sql`
      SELECT physical_shipment_id, state FROM oms.shopify_label_void_work WHERE physical_shipment_id = ANY(${sqlIntegerArray(oldPackageIds)})`));
    if (oldPackageIds.some(id => !work.some(item => Number(item.physical_shipment_id) === id && item.state === "complete"))) {
      throw new PackageReconciliationError("PREDECESSOR_CHANNEL_CORRECTION_PENDING", "Shopify predecessor correction must complete before automatic reconciliation");
    }
  }
  for (const item of retired) await tx.execute(sql`
    INSERT INTO wms.physical_shipment_item_quantity_adjustments(physical_shipment_item_id, quantity_delta, adjustment_kind,
      repair_run_id, idempotency_key, operator, reason, metadata, created_at)
    VALUES (${Number(item.id)}, ${-item.quantity_shipped}, 'provider_package_reconciliation', ${operationId}::uuid,
      ${`package-reconciliation:${operationId}:${item.id}`}, ${command.actor}, ${command.reason},
      ${JSON.stringify({ reconciliationCommandId: commandId, matchingContract: "current-package-reconciliation-v1",
        correctedContents: plan.correctedPreviousLabelIds.includes(Number(item.label_id)), previousLabelId: Number(item.label_id),
        sourceItemId: item.source_id, evidenceHash: plan.evidenceHash })}::jsonb, ${now})`);
  await tx.execute(sql`UPDATE oms.channel_fulfillment_pushes SET push_status = 'review', last_error_code = 'PACKAGE_ALLOCATION_SUPERSEDED',
    last_error = 'Verified current packages supersede this earlier allocation', updated_at = ${now}
    WHERE physical_shipment_id = ANY(${sqlIntegerArray(oldPackageIds)}) AND push_status IN ('pending', 'retry')`);
  const materialized: MaterializePhysicalPackageResult[] = [];
  for (const labelId of plan.labelIdsToMaterialize) {
    const evidence = snapshot.evidence.find(item => Number(item.label?.id) === labelId)!;
    const target = input.labels.find(item => item.labelId === labelId)!;
    const labelRow = evidence.label!;
    const proof = command.providerProof?.labels.find(item => item.labelId === labelId);
    const firstObservation = evidence.events.find(event => event.event_type === "label_observed" && typeof event.sanitized_payload.carrierCode === "string");
    const carrier = proof?.carrier ?? String(firstObservation?.sanitized_payload.carrierCode ?? "").trim();
    if (!carrier) throw new PackageReconciliationError("CARRIER_IDENTITY_MISSING", "A current target label has no authenticated carrier identity", { labelId });
    const sourceItems = target.contents.map(line => ({ sourceShipmentItemId: line.sourceItemId, quantity: line.quantity }));
    const sourceItemIds = sourceItems.map(item => item.sourceShipmentItemId);
    await tx.execute(sql`INSERT INTO wms.ebay_label_replacement_work(shipping_provider_label_id, state, reason, source_item_ids,
      created_at, updated_at, package_reconciliation_command_id)
      VALUES (${labelId}, 'waiting', 'materializing_current_packages', ${sqlIntegerArray(sourceItemIds)}, ${now}, ${now}, ${commandId}::bigint)
      ON CONFLICT(shipping_provider_label_id) DO UPDATE SET state = 'waiting', reason = EXCLUDED.reason, source_item_ids = EXCLUDED.source_item_ids,
        updated_at = EXCLUDED.updated_at, package_reconciliation_command_id = EXCLUDED.package_reconciliation_command_id
      WHERE ebay_label_replacement_work.state <> 'applied'`);
    const value = await materialize({ legacyWmsShipmentIds: [...new Set(snapshot.sources.filter(source => sourceItemIds.includes(source.id)).map(source => source.shipment_id))],
      shippingProvider: "shipstation", providerPhysicalShipmentId: labelRow.provider_label_id, providerOrderId: labelRow.provider_order_id,
      providerOrderKey: labelRow.provider_order_key, providerOrderIdentityPolicy: "stable_key_alias", trackingNumber: labelRow.tracking_number,
      carrier, serviceCode: proof?.serviceCode ?? null, shippedAt: new Date(labelRow.first_observed_at),
      source: command.mode === "adopt_existing" ? "shipstation_package_reconciliation" : "shipstation_label_replacement",
      legacyHeaderPolicy: "aggregate_projection", ...(command.mode === "adopt_existing" ? { notifyCustomer: false } : {}),
      correlationId: `package-reconciliation:${commandId}` },
    { packageScope: true, labelId, sourceItemIds, sourceItems, sourceCapacities: input.sources });
    materialized.push(value);
    await tx.execute(sql`UPDATE wms.ebay_label_replacement_work SET state = 'applied', reason = NULL,
      physical_shipment_id = ${value.physicalShipmentId}, updated_at = ${now} WHERE shipping_provider_label_id = ${labelId}`);
  }
  const channelCommandIds = materialized.flatMap(item => item.channelCommands.map(command => command.id));
  if (command.mode === "adopt_existing") await tx.execute(sql`
    UPDATE oms.channel_fulfillment_pushes SET push_status = 'review', last_error_code = 'PACKAGE_RECONCILIATION_READBACK_PENDING',
      last_error = 'Await exact authenticated channel readback; do not create another fulfillment', updated_at = ${now}
    WHERE id = ANY(${sqlIntegerArray(channelCommandIds)}) AND push_status IN ('pending', 'retry')`);
  const orders = rows<{ oms_order_id: string }>(await tx.execute(sql`
    SELECT DISTINCT line.order_id AS oms_order_id FROM wms.outbound_shipment_items item
    JOIN wms.order_items order_item ON order_item.id = item.order_item_id
    JOIN oms.oms_order_lines line ON line.id = order_item.oms_order_line_id WHERE item.id = ANY(${sqlIntegerArray(snapshot.sourceIds)}) ORDER BY line.order_id`));
  const result: PackageReconciliationResult = { commandId, operationId, evidenceHash: plan.evidenceHash,
    physicalShipmentIds: materialized.map(item => item.physicalShipmentId), channelCommandIds, sourceItemIds: snapshot.sourceIds,
    omsOrderIds: orders.map(item => Number(item.oms_order_id)), correctedPreviousLabelIds: plan.correctedPreviousLabelIds, replayed: false };
  await tx.execute(sql`UPDATE oms.package_reconciliation_commands SET state = 'applied', result = ${JSON.stringify(result)}::jsonb,
    applied_at = ${now} WHERE id = ${commandId}`);
  return result;
}

export async function readReconciliationCommand(tx: Transaction, commandKey: string): Promise<PackageReconciliationResult | null> {
  const found = rows<{ result: PackageReconciliationResult | null }>(await tx.execute(sql`SELECT result FROM oms.package_reconciliation_commands WHERE command_key = ${commandKey}`))[0];
  return found?.result ? { ...found.result, replayed: true } : null;
}

export async function loadReconciliationReplay(tx: Transaction, commandKey: string): Promise<Readonly<{
  command: PackageReconciliationCommand; result: PackageReconciliationResult; state: string; readbacks: readonly PackageChannelReadback[] | null;
}> | null> {
  const found = rows<{ evidence: { command: PackageReconciliationCommand }; result: PackageReconciliationResult; state: string; channel_readbacks: unknown }>(await tx.execute(sql`
    SELECT evidence, result, state, channel_readbacks FROM oms.package_reconciliation_commands WHERE command_key = ${z.string().trim().min(1).max(200).parse(commandKey)}`))[0];
  return found?.result ? { command: packageReconciliationCommandSchema.parse(found.evidence.command), result: found.result, state: found.state,
    readbacks: found.channel_readbacks === null ? null : z.array(packageChannelReadbackSchema).min(1).max(500).parse(found.channel_readbacks) } : null;
}

export async function findPendingPackageReconciliations(tx: Transaction, limit: number, now: Date): Promise<readonly PackageReconciliationCommand[]> {
  z.number().int().min(1).max(25).parse(limit);
  return rows<{ command: PackageReconciliationCommand }>(await tx.execute(sql`SELECT evidence->'command' AS command
    FROM oms.package_reconciliation_commands WHERE mode='adopt_existing' AND state='applied' AND resume_attempt_count < 8
      AND (next_resume_at IS NULL OR next_resume_at <= ${now}) ORDER BY id LIMIT ${limit}`)).map(item => packageReconciliationCommandSchema.parse(item.command));
}
export async function recordPackageReconciliationFailure(tx: Transaction, commandKey: string, code: string, now: Date): Promise<void> {
  await tx.execute(sql`UPDATE oms.package_reconciliation_commands SET resume_attempt_count=LEAST(resume_attempt_count+1,8),
    next_resume_at=${now}::timestamptz + make_interval(secs => LEAST(3600,30*power(2,resume_attempt_count)::integer)),
    last_error_code=${code.slice(0,100)} WHERE command_key=${commandKey} AND state='applied'`);
}

export async function recordPackageReconciliationTrackingIntent(tx: Transaction, input: {
  readonly commandId: number; readonly omsOrderId: number; readonly actor: string;
  readonly before: { readonly id: string; readonly status: string; readonly trackingNumbers: readonly string[]; readonly items: readonly { lineId: string; quantity: number }[] };
  readonly trackingNumber: string;
}, now: Date): Promise<void> {
  const receipt = rows<{ actor: string; result: PackageReconciliationResult }>(await tx.execute(sql`
    SELECT actor,result FROM oms.package_reconciliation_commands WHERE id=${input.commandId} AND state='applied'`))[0];
  if (!receipt || receipt.actor !== input.actor || !receipt.result.omsOrderIds.includes(input.omsOrderId)) {
    throw new PackageReconciliationError("TRACKING_INTENT_SCOPE_CONFLICT", "Tracking correction requires the exact applied package reconciliation and originating order");
  }
  const requestHash = digest(input);
  await tx.execute(sql`INSERT INTO oms.oms_order_events(order_id,event_type,details,created_at)
    SELECT ${input.omsOrderId},'package_reconciliation_tracking_requested',${JSON.stringify({ ...input,requestHash,notifyCustomer:false })}::jsonb,${now}
    WHERE NOT EXISTS(SELECT 1 FROM oms.oms_order_events WHERE order_id=${input.omsOrderId}
      AND event_type='package_reconciliation_tracking_requested' AND details->>'requestHash'=${requestHash})`);
}

export interface PackageReconciliationChannelScope {
  readonly physicalShipmentId: number;
  readonly omsOrderId: number;
  readonly channelId: number;
  readonly externalOrderId: string;
  readonly channelProvider: string;
  readonly trackingNumber: string;
  readonly carrier: string;
  readonly items: readonly { channelOrderLineId: string; quantity: number }[];
  readonly allowedPreviousTrackingNumbers: readonly string[];
}
export async function readReconciliationChannelScopes(tx: Transaction, commandId: number): Promise<readonly PackageReconciliationChannelScope[]> {
  integer.parse(commandId);
  const receipt = rows<{ evidence: PackageReconciliationInput; plan: PackageReconciliationPlan; result: PackageReconciliationResult }>(await tx.execute(sql`
    SELECT evidence, plan, result FROM oms.package_reconciliation_commands WHERE id = ${commandId} AND state IN ('applied','complete')`))[0];
  if (!receipt || (receipt.plan.outcome !== "ready" && receipt.plan.outcome !== "unchanged")) throw new PackageReconciliationError("RECEIPT_MISSING", "An applied reconciliation receipt is required");
  const retiredPhysicalIds = receipt.plan.physicalItemIdsToRetire;
  const items = rows<{ physical_shipment_id: string; oms_order_id: string; channel_id: number; external_order_id: string; channel_provider: string;
    tracking_number: string; carrier: string; external_line_item_id: string; source_id: number; quantity: number }>(await tx.execute(sql`
    SELECT item.physical_shipment_id, line.order_id AS oms_order_id, orders.channel_id, orders.external_order_id, channel.provider AS channel_provider,
      package.tracking_number, package.carrier, line.external_line_item_id,
      COALESCE(item.legacy_wms_shipment_item_id,item.label_replacement_source_item_id,source.source_wms_shipment_item_id) AS source_id,
      SUM(item.quantity_shipped)::int AS quantity
    FROM wms.effective_physical_shipment_items item JOIN wms.physical_shipments package ON package.id=item.physical_shipment_id
    LEFT JOIN wms.package_allocation_entries entry ON entry.id=item.package_allocation_entry_id
    LEFT JOIN wms.package_allocation_source_lines source ON source.id=entry.package_allocation_source_line_id
    JOIN wms.order_items order_item ON order_item.id=item.wms_order_item_id
    JOIN oms.oms_order_lines line ON line.id=order_item.oms_order_line_id JOIN oms.oms_orders orders ON orders.id=line.order_id
    JOIN channels.channels channel ON channel.id=orders.channel_id
    WHERE COALESCE(item.legacy_wms_shipment_item_id,item.label_replacement_source_item_id,source.source_wms_shipment_item_id)
      = ANY(${sqlIntegerArray(receipt.result.sourceItemIds)})
    GROUP BY item.physical_shipment_id,line.order_id,orders.channel_id,orders.external_order_id,channel.provider,
      package.tracking_number,package.carrier,line.external_line_item_id,source_id ORDER BY item.physical_shipment_id,line.order_id,source_id`));
  const groups = new Map<string, typeof items>();
  for (const item of items) { const key = `${item.physical_shipment_id}:${item.oms_order_id}`; const entries = groups.get(key) ?? []; entries.push(item); groups.set(key, entries); }
  return [...groups.values()].map(group => {
    const first = group[0];
    const lines = new Map<string, number>();
    for (const item of group) lines.set(String(item.external_line_item_id), (lines.get(String(item.external_line_item_id)) ?? 0) + item.quantity);
    const retired = receipt.evidence.previous.filter(item => retiredPhysicalIds.includes(item.physicalItemId) && group.some(current => current.source_id === item.sourceItemId));
    return { physicalShipmentId: Number(first.physical_shipment_id), omsOrderId: Number(first.oms_order_id), channelId: first.channel_id,
      externalOrderId: first.external_order_id, channelProvider: first.channel_provider, trackingNumber: first.tracking_number, carrier: first.carrier,
      items: [...lines].map(([channelOrderLineId, quantity]) => ({ channelOrderLineId, quantity })),
      allowedPreviousTrackingNumbers: [...new Set(retired.map(item => receipt.evidence.labels.find(label => label.labelId === item.labelId)!.trackingNumber))] };
  });
}

export const packageChannelReadbackSchema = z.object({
  physicalShipmentId: integer, omsOrderId: integer, channelId: integer,
  fulfillmentId: z.string().trim().min(1).max(300), trackingNumber: z.string().trim().min(1).max(200),
  items: z.array(z.object({ channelOrderLineId: z.string().trim().min(1).max(200), quantity: z.number().int().positive().max(2_147_483_647) }).strict()).min(1).max(500),
  observedAt: z.string().datetime(),
}).strict();
export type PackageChannelReadback = z.infer<typeof packageChannelReadbackSchema>;

/** This is adoption of a successful provider readback, never a second create.
 * Only the service's authenticated channel reader supplies these observations.
 * Original command intent and every earlier attempt remain unchanged. */
export async function completePackageReconciliation(tx: Transaction, commandId: number,
  rawReadbacks: readonly PackageChannelReadback[], now: Date,
  adoptCommand: (commandId: number, readback: PackageChannelReadback) => Promise<void>,
): Promise<Readonly<{ replayed: boolean; resolvedReviewIds: readonly number[] }>> {
  integer.parse(commandId);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new PackageReconciliationError('INVALID_CLOCK', 'Package reconciliation requires a valid injected clock');
  const readbacks = z.array(packageChannelReadbackSchema).min(1).max(500).parse(rawReadbacks);
  const receipt = rows<{ state: string; actor: string; reason: string; evidence: PackageReconciliationInput;
    result: PackageReconciliationResult; channel_readbacks: PackageChannelReadback[] | null }>(await tx.execute(sql`
    SELECT state, actor, reason, evidence, result, channel_readbacks FROM oms.package_reconciliation_commands WHERE id = ${commandId} FOR UPDATE`))[0];
  if (!receipt || !receipt.result || receipt.state === "applying") throw new PackageReconciliationError("RECEIPT_MISSING", "An applied package reconciliation receipt is required");
  const stripTime = (value: readonly PackageChannelReadback[]) => value.map(({ observedAt: _at, ...item }) => ({ ...item,
    items: [...item.items].sort((a, b) => a.channelOrderLineId.localeCompare(b.channelOrderLineId)) }))
    .sort((a, b) => a.physicalShipmentId - b.physicalShipmentId || a.omsOrderId - b.omsOrderId);
  if (receipt.state === "complete") {
    if (!receipt.channel_readbacks || canonicalJson(stripTime(receipt.channel_readbacks)) !== canonicalJson(stripTime(readbacks))) {
      throw new PackageReconciliationError("CHANNEL_READBACK_REPLAY_CONFLICT", "Completed reconciliation cannot adopt different channel packages");
    }
    return { replayed: true, resolvedReviewIds: [] };
  }
  for (const readback of readbacks) {
    const age = now.getTime() - Date.parse(readback.observedAt);
    if (!Number.isFinite(age) || age < -30_000 || age > 5 * 60_000) throw new PackageReconciliationError("CHANNEL_READBACK_EXPIRED", "Refresh the channel package readback before completing reconciliation");
  }
  const expectedRows = rows<{ physical_shipment_id: string; oms_order_id: string; channel_id: number; channel_order_line_id: string;
    tracking_number: string; quantity: number }>(await tx.execute(sql`
    SELECT item.physical_shipment_id, line.order_id AS oms_order_id, orders.channel_id,
      line.external_line_item_id AS channel_order_line_id, package.tracking_number, SUM(item.quantity_shipped)::int AS quantity
    FROM wms.effective_physical_shipment_items item JOIN wms.physical_shipments package ON package.id = item.physical_shipment_id
    LEFT JOIN wms.package_allocation_entries entry ON entry.id = item.package_allocation_entry_id
    LEFT JOIN wms.package_allocation_source_lines source ON source.id = entry.package_allocation_source_line_id
    JOIN wms.order_items order_item ON order_item.id = item.wms_order_item_id
    JOIN oms.oms_order_lines line ON line.id = order_item.oms_order_line_id JOIN oms.oms_orders orders ON orders.id = line.order_id
    WHERE COALESCE(item.legacy_wms_shipment_item_id, item.label_replacement_source_item_id, source.source_wms_shipment_item_id)
      = ANY(${sqlIntegerArray(receipt.result.sourceItemIds)})
    GROUP BY item.physical_shipment_id, line.order_id, orders.channel_id, line.external_line_item_id, package.tracking_number
    ORDER BY item.physical_shipment_id, line.order_id, line.external_line_item_id`));
  const expected = new Map<string, typeof expectedRows>();
  for (const row of expectedRows) {
    const key = `${row.physical_shipment_id}:${row.oms_order_id}`;
    const entries = expected.get(key) ?? []; entries.push(row); expected.set(key, entries);
  }
  if (readbacks.length !== expected.size || new Set(readbacks.map(item => `${item.physicalShipmentId}:${item.omsOrderId}`)).size !== readbacks.length) {
    throw new PackageReconciliationError("CHANNEL_PACKAGE_SCOPE_CONFLICT", "Readback must cover every current package and order exactly once");
  }
  for (const readback of readbacks) {
    const items = expected.get(`${readback.physicalShipmentId}:${readback.omsOrderId}`);
    const actualItems = [...readback.items].sort((a, b) => a.channelOrderLineId.localeCompare(b.channelOrderLineId));
    const expectedItems = items?.map(item => ({ channelOrderLineId: String(item.channel_order_line_id), quantity: item.quantity }))
      .sort((a, b) => a.channelOrderLineId.localeCompare(b.channelOrderLineId));
    if (!items || items.some(item => item.channel_id !== readback.channelId || item.tracking_number !== readback.trackingNumber)
      || canonicalJson(actualItems) !== canonicalJson(expectedItems)) throw new PackageReconciliationError("CHANNEL_PACKAGE_SCOPE_CONFLICT", "Native fulfillment tracking or exact order-line quantities disagree with canonical allocation");
  }
  const commands = rows<{ id: string | number; physical_shipment_id: string; oms_order_id: string; request_hash: string; attempt_count: number;
    push_status: string; last_error_code: string | null; last_error: string | null; channel_fulfillment_id: string | null }>(await tx.execute(sql`
    SELECT id, physical_shipment_id, oms_order_id, request_hash, attempt_count, push_status, last_error_code, last_error, channel_fulfillment_id
    FROM oms.channel_fulfillment_pushes WHERE id = ANY(${sqlIntegerArray(receipt.result.channelCommandIds)}) ORDER BY id FOR UPDATE`));
  if (commands.length !== receipt.result.channelCommandIds.length) throw new PackageReconciliationError("CHANNEL_COMMAND_SCOPE_CONFLICT", "Reconciliation channel command set is incomplete");
  for (const command of commands) {
    const readback = readbacks.find(item => item.physicalShipmentId === Number(command.physical_shipment_id) && item.omsOrderId === Number(command.oms_order_id));
    if (!readback) throw new PackageReconciliationError("CHANNEL_COMMAND_SCOPE_CONFLICT", "A command has no exact current provider readback");
    if (command.push_status === "success" && command.channel_fulfillment_id === readback.fulfillmentId) continue;
    if (command.push_status !== "review" || command.last_error_code !== "PACKAGE_RECONCILIATION_READBACK_PENDING") {
      throw new PackageReconciliationError("CHANNEL_COMMAND_IN_PROGRESS", "Only reconciliation-held commands may adopt an existing channel fulfillment");
    }
    // Use the existing audited review -> pending -> claimed -> success lifecycle.
    // These transitions commit together, so a worker never sees the intermediate
    // pending command and cannot create another already-fulfilled package.
    await tx.execute(sql`INSERT INTO oms.channel_fulfillment_push_requeues(channel_fulfillment_push_id,idempotency_key,operator,reason,
      previous_status,previous_attempt_count,previous_error_code,previous_error_message,previous_request_hash,created_at,notify_customer_override)
      VALUES(${command.id},${`package-reconciliation-readback:${commandId}`},${receipt.actor},'Adopt the exact authenticated existing fulfillment readback',
        'review',${command.attempt_count},${command.last_error_code},${command.last_error},${command.request_hash},${now},FALSE)`);
    await tx.execute(sql`UPDATE oms.channel_fulfillment_pushes SET push_status='pending',next_attempt_at=${now},
      last_error_code=NULL,last_error=NULL,completed_at=NULL,updated_at=${now} WHERE id=${command.id}`);
    await adoptCommand(databaseId(command.id,'channel fulfillment command'),readback);
  }
  await tx.execute(sql`UPDATE oms.package_reconciliation_commands SET state = 'complete', channel_readbacks = ${JSON.stringify(readbacks)}::jsonb,
    completed_at = ${now} WHERE id = ${commandId}`);
  const labelIds = receipt.evidence.labels.map(item => item.labelId);
  const resolved = rows<{ id: string }>(await tx.execute(sql`UPDATE wms.reconciliation_exceptions SET status = 'resolved',
    resolved_at = ${now}, resolved_by = ${receipt.actor}, resolution = 'Verified canonical current packages and exact native channel line readbacks; earlier evidence retained',
    details = details || ${JSON.stringify({ packageReconciliationCommandId: commandId, evidenceHash: receipt.result.evidenceHash,
      inventoryMutated: false, notifyCustomer: false })}::jsonb, updated_at = ${now}
    WHERE source = 'shipstation_label_commercial_fulfillment' AND status IN ('open', 'acknowledged')
      AND (details->>'shippingProviderLabelId')::bigint = ANY(${sqlIntegerArray(labelIds)}) RETURNING id`));
  await tx.execute(sql`UPDATE wms.ebay_label_replacement_work SET projected_at = ${now}
    WHERE package_reconciliation_command_id = ${commandId} AND state = 'applied' AND projected_at IS NULL`);
  for (const orderId of receipt.result.omsOrderIds) await tx.execute(sql`INSERT INTO oms.oms_order_events(order_id, event_type, details, created_at)
    VALUES (${orderId}, 'package_reconciliation_completed', ${JSON.stringify({ commandId, actor: receipt.actor, reason: receipt.reason,
      evidenceHash: receipt.result.evidenceHash, readbacks: readbacks.filter(item => item.omsOrderId === orderId),
      inventoryMutated: false, notifyCustomer: false, failedVoidAttemptsPreserved: true })}::jsonb, ${now})`);
  return { replayed: false, resolvedReviewIds: resolved.map(item => Number(item.id)) };
}
