import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import type { ChannelExposurePolicyValue } from "@shared/types/inventory-channel-exposure";
import { canonicalJson } from "@shared/utils/canonical-json";

import { pool as defaultPool } from "../../../db";
import {
  AuthorityAwareInventoryPublicationService,
  InventoryAvailabilityRuntimePublicationError,
  type ActiveInventoryPublicationTarget,
  type ActivePublicationVariantMapping,
  type CanonicalInventoryPublicationEnqueueResult,
  type CanonicalInventoryPublicationIntent,
  type InventoryAvailabilityRuntimePublicationContext,
  type InventoryAvailabilityRuntimePublicationExecutor,
  type InventoryAvailabilityRuntimePublicationLogger,
} from "../application/inventory-availability-runtime-publication.service";
import { planInventoryChannelExposureProduct } from "../application/inventory-channel-exposure-runtime.service";
import type { ChannelExposurePolicyCandidate } from "../domain/inventory-channel-exposure";
import { loadAndLockRuntimeAuthority } from "./inventory-availability-runtime-atp.repository";
import {
  loadActivePublicationTargets as loadChannelExposurePublicationTargets,
  loadManagedSellableVariantIds,
} from "./inventory-channel-exposure-runtime.repository";
import { captureActiveSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";

type ClientPool = Pick<Pool, "connect"> & { options?: { max?: number } };

interface TargetRow extends Record<string, unknown> {
  publication_target_id: number;
  publication_target_revision: string;
  destination_kind: string;
  channel_id: number;
  channel_name: string;
  provider_key: string;
  channel_connection_id: number | null;
  dropship_store_connection_id: number | null;
  provider_scope_type: string;
  external_scope_id: string;
  active_binding_id: number | null;
  binding_lifecycle_status: string | null;
  warehouse_id: number | null;
  fulfillment_node_lifecycle_status: string | null;
  warehouse_is_active: boolean | null;
}

interface PolicyRow extends Record<string, unknown> {
  scope_key: string;
  scope_type: string;
  channel_id: number;
  product_id: number | null;
  product_variant_id: number | null;
  lifecycle_status: string;
  allocation_semantics: string | null;
  eligible: boolean | null;
  share_bps: number | null;
  holdback_sellable_units: string | null;
  max_publish_mode: string | null;
  max_publish_sellable_units: string | null;
  min_publish_sellable_units: string | null;
}

interface MappingRow extends Record<string, unknown> {
  publication_target_id: number;
  product_variant_id: number;
  lifecycle_status: string;
  external_inventory_item_id: string;
  external_sku: string | null;
}

interface LatestPublicationRow extends Record<string, unknown> {
  state: string;
  desired_quantity: string;
  desired_revision: string;
  activation_run_id: string | null;
  publication_target_revision_snapshot: string | null;
  channel_id_snapshot: number | null;
  channel_connection_id_snapshot: number;
  provider_key_snapshot: string | null;
  provider_scope_type_snapshot: string | null;
  external_scope_id_snapshot: string;
  external_inventory_item_id_snapshot: string;
  external_sku_snapshot: string | null;
}

/**
 * Pins the authority decision for every direct legacy provider write. Canonical
 * planning and outbox insertion share one serializable transaction, so the
 * captured ATP, active target identities, and desired revisions commit together.
 */
export class PostgresInventoryAvailabilityRuntimePublicationExecutor
implements InventoryAvailabilityRuntimePublicationExecutor {
  private readonly routingSlots: AsyncSemaphore;

  constructor(
    private readonly connectionPool: ClientPool = defaultPool,
    private readonly logger?: InventoryAvailabilityRuntimePublicationLogger,
  ) {
    assertNestedConnectionCapacity(connectionPool);
    this.routingSlots = new AsyncSemaphore(routingConcurrency(connectionPool));
  }

  async execute<T>(
    work: (context: InventoryAvailabilityRuntimePublicationContext) => Promise<T>,
  ): Promise<T> {
    const releaseRoutingSlot = await this.routingSlots.acquire();
    let client: PoolClient | null = null;
    let began = false;
    try {
      client = await this.connectionPool.connect();
      const connectedClient = client;
      await connectedClient.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      began = true;
      const authority = await loadAndLockRuntimeAuthority(connectedClient);
      if (authority.authority === "canonical") {
        await assertActivationIsActive(connectedClient, authority.activationRunId!);
      }
      const result = await work({
        authority: authority.authority,
        authorityRevision: authority.authorityRevision,
        activationRunId: authority.activationRunId,
        listActivePublicationProductIds: (channelId) =>
          listActivePublicationProductIds(connectedClient, channelId),
        planProduct: async (productId, channelId) => {
          const supplySnapshot = await captureActiveSupplySnapshotInsideTransaction(
            connectedClient,
            productId,
          );
          const managedSellableVariantIds = await loadManagedSellableVariantIds(
            connectedClient,
            productId,
          );
          const publicationTargets = await loadChannelExposurePublicationTargets(
            connectedClient,
            productId,
            managedSellableVariantIds,
            channelId,
          );
          return planInventoryChannelExposureProduct({
            ...authority,
            supplySnapshot,
            managedSellableVariantIds,
            publicationTargets,
          }, productId, this.logger);
        },
        loadActivePublicationTargets: (input) =>
          loadZeroPublicationTargets(connectedClient, input),
        enqueueFullPublications: (activationRunId, intents) =>
          enqueueFullPublications(connectedClient, activationRunId, intents),
      });
      await connectedClient.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began && client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Inventory publication routing and authority-lock rollback both failed.",
          );
        }
      }
      throw error;
    } finally {
      try {
        client?.release();
      } finally {
        releaseRoutingSlot();
      }
    }
  }
}

export function createAuthorityAwareInventoryPublicationService(
  connectionPool: ClientPool = defaultPool,
  options: {
    channelId?: number;
    logger?: InventoryAvailabilityRuntimePublicationLogger;
  } = {},
): AuthorityAwareInventoryPublicationService {
  return new AuthorityAwareInventoryPublicationService(
    new PostgresInventoryAvailabilityRuntimePublicationExecutor(connectionPool, options.logger),
    options.channelId,
    options.logger,
  );
}

async function assertActivationIsActive(client: PoolClient, activationRunId: string): Promise<void> {
  const row = (await client.query<{ state: string }>(
    `SELECT state
     FROM inventory.availability_activation_runs
     WHERE id = $1 AND mode = 'activation'
     FOR SHARE`,
    [activationRunId],
  )).rows[0];
  if (!row || row.state !== "active") {
    throw runtimeError(
      "INVENTORY_PUBLICATION_ACTIVATION_NOT_ACTIVE",
      "Canonical inventory publication requires its activation run to be active.",
      { activationRunId, activationState: row?.state ?? null },
    );
  }
}

async function listActivePublicationProductIds(
  client: PoolClient,
  channelId?: number,
): Promise<number[]> {
  const values: unknown[] = [];
  const channelFilter = channelId == null ? "" : "AND target.channel_id = $1";
  if (channelId != null) values.push(positiveInteger(channelId, "channelId"));
  const rows = (await client.query<{ product_id: number }>(
    `SELECT DISTINCT variant.product_id
     FROM inventory.inventory_publication_targets AS target
     JOIN inventory.publication_variant_mapping_heads AS mapping_head
       ON mapping_head.publication_target_id = target.id
      AND mapping_head.active_mapping_id IS NOT NULL
     JOIN catalog.product_variants AS variant
       ON variant.id = mapping_head.product_variant_id
     WHERE target.state = 'live'
       AND target.publication_authority = 'echelon'
       AND variant.is_active = true
       AND variant.requires_shipping = true
       AND COALESCE(variant.track_inventory, true) = true
       AND variant.sales_eligibility = 'sellable'
       ${channelFilter}
     ORDER BY variant.product_id`,
    values,
  )).rows;
  return rows.map((row) => positiveInteger(row.product_id, "productId"));
}

async function loadZeroPublicationTargets(
  client: PoolClient,
  input: {
    productId: number;
    productVariantIds: readonly number[];
    channelId?: number;
  },
): Promise<ActiveInventoryPublicationTarget[]> {
  const productId = positiveInteger(input.productId, "productId");
  const variantIds = uniquePositiveIntegers(input.productVariantIds, "productVariantId");
  if (variantIds.length === 0) return [];
  const values: unknown[] = [productId, variantIds];
  const channelFilter = input.channelId == null ? "" : "AND target.channel_id = $3";
  if (input.channelId != null) values.push(positiveInteger(input.channelId, "channelId"));
  const targetRows = (await client.query<TargetRow>(
    `SELECT target.id AS publication_target_id,
            target.revision::text AS publication_target_revision,
            target.destination_kind,
            target.channel_id, channel_row.name AS channel_name,
            lower(channel_row.provider) AS provider_key,
            target.channel_connection_id, target.dropship_store_connection_id,
            target.provider_scope_type,
            target.external_scope_id, binding_head.active_binding_id,
            binding.lifecycle_status AS binding_lifecycle_status,
            node.warehouse_id,
            node.lifecycle_status AS fulfillment_node_lifecycle_status,
            warehouse_row.is_active = 1 AS warehouse_is_active
     FROM inventory.inventory_publication_targets AS target
     JOIN channels.channels AS channel_row ON channel_row.id = target.channel_id
     LEFT JOIN inventory.publication_source_binding_heads AS binding_head
       ON binding_head.publication_target_id = target.id
     LEFT JOIN inventory.publication_source_binding_versions AS binding
       ON binding.id = binding_head.active_binding_id
      AND binding.publication_target_id = target.id
     LEFT JOIN inventory.publication_source_binding_members AS member
       ON member.binding_id = binding.id
     LEFT JOIN warehouse.fulfillment_nodes AS node
       ON node.id = member.fulfillment_node_id
     LEFT JOIN warehouse.warehouses AS warehouse_row
       ON warehouse_row.id = node.warehouse_id
     WHERE target.state = 'live'
       AND target.publication_authority = 'echelon'
       AND EXISTS (
         SELECT 1
         FROM catalog.product_variants AS selected_variant
         WHERE selected_variant.product_id = $1
           AND selected_variant.id = ANY($2::integer[])
       )
       ${channelFilter}
     ORDER BY target.id, member.priority, member.fulfillment_node_id`,
    values,
  )).rows;
  const targetIds = [...new Set(targetRows.map((row) =>
    positiveInteger(row.publication_target_id, "publicationTargetId")))];
  if (targetIds.length === 0) return [];
  const channelIds = [...new Set(targetRows.map((row) =>
    positiveInteger(row.channel_id, "channelId")))];
  const policyRows = (await client.query<PolicyRow>(
    `SELECT policy.scope_key, policy.scope_type, policy.channel_id,
            policy.product_id, policy.product_variant_id, policy.lifecycle_status,
            policy.allocation_semantics, policy.eligible, policy.share_bps,
            policy.holdback_sellable_units::text AS holdback_sellable_units,
            policy.max_publish_mode,
            policy.max_publish_sellable_units::text AS max_publish_sellable_units,
            policy.min_publish_sellable_units::text AS min_publish_sellable_units
     FROM inventory.channel_exposure_policy_heads AS head
     JOIN inventory.channel_exposure_policy_versions AS policy
       ON policy.id = head.active_policy_id
      AND policy.scope_key = head.scope_key
     WHERE head.channel_id = ANY($1::integer[])
       AND (policy.scope_type = 'channel' OR policy.product_id = $2)
     ORDER BY policy.channel_id, policy.scope_key`,
    [channelIds, productId],
  )).rows;
  const mappingRows = (await client.query<MappingRow>(
    `SELECT mapping.publication_target_id, mapping.product_variant_id,
            mapping.lifecycle_status, mapping.external_inventory_item_id,
            mapping.external_sku
     FROM inventory.publication_variant_mapping_heads AS head
     JOIN inventory.publication_variant_mapping_versions AS mapping
       ON mapping.id = head.active_mapping_id
      AND mapping.publication_target_id = head.publication_target_id
      AND mapping.product_variant_id = head.product_variant_id
     WHERE head.publication_target_id = ANY($1::integer[])
       AND head.product_variant_id = ANY($2::integer[])
     ORDER BY mapping.publication_target_id, mapping.product_variant_id`,
    [targetIds, variantIds],
  )).rows;

  const policiesByChannel = new Map<number, ChannelExposurePolicyCandidate[]>();
  for (const row of policyRows) {
    const candidate = parsePolicy(row);
    const rows = policiesByChannel.get(positiveInteger(row.channel_id, "policy.channelId")) ?? [];
    rows.push(candidate);
    policiesByChannel.set(positiveInteger(row.channel_id, "policy.channelId"), rows);
  }
  const mappingsByTarget = new Map<number, ActivePublicationVariantMapping[]>();
  for (const row of mappingRows) {
    if (row.lifecycle_status !== "sealed") {
      throw runtimeError(
        "INVENTORY_PUBLICATION_ACTIVE_MAPPING_INVALID",
        "An active publication mapping does not reference a sealed definition.",
        { publicationTargetId: row.publication_target_id, productVariantId: row.product_variant_id },
      );
    }
    const targetId = positiveInteger(row.publication_target_id, "mapping.publicationTargetId");
    const rows = mappingsByTarget.get(targetId) ?? [];
    rows.push({
      productVariantId: positiveInteger(row.product_variant_id, "mapping.productVariantId"),
      externalInventoryItemId: nonblank(row.external_inventory_item_id, "mapping.externalInventoryItemId", 240),
      externalSku: nullableNonblank(row.external_sku, "mapping.externalSku", 100),
    });
    mappingsByTarget.set(targetId, rows);
  }

  const rowsByTarget = new Map<number, TargetRow[]>();
  for (const row of targetRows) {
    const targetId = positiveInteger(row.publication_target_id, "publicationTargetId");
    const rows = rowsByTarget.get(targetId) ?? [];
    rows.push(row);
    rowsByTarget.set(targetId, rows);
  }
  return [...rowsByTarget.entries()].map(([targetId, rows]) => {
    const first = rows[0]!;
    const sourceBindingId = first.active_binding_id == null
      ? null
      : positiveInteger(first.active_binding_id, "sourceBindingId");
    if (sourceBindingId !== null && first.binding_lifecycle_status !== "sealed") {
      throw runtimeError(
        "INVENTORY_PUBLICATION_ACTIVE_SOURCE_BINDING_INVALID",
        "An active publication source binding does not reference a sealed definition.",
        { publicationTargetId: targetId, sourceBindingId },
      );
    }
    const warehouseIds = rows.flatMap((row) => {
      if (row.warehouse_id == null) return [];
      if (row.fulfillment_node_lifecycle_status !== "active" || row.warehouse_is_active !== true) {
        throw runtimeError(
          "INVENTORY_PUBLICATION_SOURCE_WAREHOUSE_INACTIVE",
          "A live publication target references an inactive fulfillment node or warehouse.",
          { publicationTargetId: targetId, warehouseId: row.warehouse_id },
        );
      }
      return [positiveInteger(row.warehouse_id, "sourceWarehouseId")];
    });
    const channelId = positiveInteger(first.channel_id, "channelId");
    if (first.destination_kind !== "channel_connection"
      || first.channel_connection_id == null
      || first.dropship_store_connection_id != null) {
      throw runtimeError(
        "INVENTORY_PUBLICATION_DESTINATION_UNSUPPORTED",
        "The canonical publication outbox does not support this destination owner yet.",
        {
          publicationTargetId: targetId,
          destinationKind: first.destination_kind,
          dropshipStoreConnectionId: first.dropship_store_connection_id,
        },
      );
    }
    return {
      publicationTargetId: targetId,
      publicationTargetRevision: positiveBigintString(
        first.publication_target_revision,
        "publicationTargetRevision",
      ),
      channelId,
      channelName: nonblank(first.channel_name, "channelName", 255),
      providerKey: nonblank(first.provider_key, "providerKey", 60),
      channelConnectionId: positiveInteger(first.channel_connection_id, "channelConnectionId"),
      providerScopeType: providerScopeType(first.provider_scope_type),
      externalScopeId: nonblank(first.external_scope_id, "externalScopeId", 240),
      sourceBindingId,
      sourceWarehouseIds: uniquePositiveIntegers(warehouseIds, "sourceWarehouseId"),
      policies: policiesByChannel.get(channelId) ?? [],
      mappings: mappingsByTarget.get(targetId) ?? [],
    };
  }).sort((left, right) => left.publicationTargetId - right.publicationTargetId);
}

function parsePolicy(row: PolicyRow): ChannelExposurePolicyCandidate {
  if (row.lifecycle_status !== "sealed") {
    throw runtimeError(
      "INVENTORY_PUBLICATION_ACTIVE_POLICY_INVALID",
      "An active channel-exposure policy does not reference a sealed definition.",
      { scopeKey: row.scope_key },
    );
  }
  const scopeType = String(row.scope_type);
  if (!["channel", "product", "variant"].includes(scopeType)) {
    throw runtimeError(
      "INVENTORY_PUBLICATION_ACTIVE_POLICY_INVALID",
      "An active channel-exposure policy has an invalid scope.",
      { scopeKey: row.scope_key, scopeType },
    );
  }
  const maxPublish = row.max_publish_mode == null
    ? null
    : row.max_publish_mode === "unlimited"
      ? { mode: "unlimited" as const }
      : row.max_publish_mode === "units" && row.max_publish_sellable_units != null
        ? {
            mode: "units" as const,
            units: nonnegativeBigintString(row.max_publish_sellable_units, "policy.maxPublishUnits"),
          }
        : invalidPolicyMax(row);
  const value: ChannelExposurePolicyValue = {
    allocationSemantics: nullableEnum(
      row.allocation_semantics,
      ["exposure", "partitioned"] as const,
      "policy.allocationSemantics",
    ),
    eligible: nullableBoolean(row.eligible, "policy.eligible"),
    shareBps: nullableBasisPoints(row.share_bps, "policy.shareBps"),
    holdbackSellableUnits: nullableNonnegativeBigintString(
      row.holdback_sellable_units,
      "policy.holdbackSellableUnits",
    ),
    maxPublish,
    minPublishSellableUnits: nullableNonnegativeBigintString(
      row.min_publish_sellable_units,
      "policy.minPublishSellableUnits",
    ),
  };
  return {
    scopeKey: nonblank(row.scope_key, "policy.scopeKey", 200),
    scopeType: scopeType as ChannelExposurePolicyCandidate["scopeType"],
    value,
  };
}

function invalidPolicyMax(row: PolicyRow): never {
  throw runtimeError(
    "INVENTORY_PUBLICATION_ACTIVE_POLICY_INVALID",
    "An active channel-exposure policy has an invalid maximum publication value.",
    { scopeKey: row.scope_key, maxPublishMode: row.max_publish_mode },
  );
}

async function enqueueFullPublications(
  client: PoolClient,
  activationRunId: string,
  intents: readonly CanonicalInventoryPublicationIntent[],
): Promise<CanonicalInventoryPublicationEnqueueResult> {
  positiveBigintString(activationRunId, "activationRunId");
  let enqueuedRows = 0;
  let coalescedRows = 0;
  const enqueuedPublicationKeys: string[] = [];
  const coalescedPublicationKeys: string[] = [];
  const ordered = [...intents].sort((left, right) =>
    left.publicationTargetId - right.publicationTargetId
    || left.productVariantId - right.productVariantId);
  for (const intent of ordered) {
    await client.query(
      "SELECT pg_advisory_xact_lock($1, $2)",
      [intent.publicationTargetId, intent.productVariantId],
    );
    const latest = (await client.query<LatestPublicationRow>(
      `SELECT activation_run_id::text AS activation_run_id, state,
              desired_revision::text AS desired_revision,
              desired_quantity::text AS desired_quantity,
              publication_target_revision_snapshot::text AS publication_target_revision_snapshot,
              channel_id_snapshot, channel_connection_id_snapshot,
              provider_key_snapshot, provider_scope_type_snapshot,
              external_scope_id_snapshot, external_inventory_item_id_snapshot,
              external_sku_snapshot
       FROM inventory.inventory_publication_outbox
       WHERE publication_target_id = $1 AND product_variant_id = $2
       ORDER BY desired_revision DESC
       LIMIT 1
       FOR UPDATE`,
      [intent.publicationTargetId, intent.productVariantId],
    )).rows[0];
    if (latest && reusablePublicationState(latest.state)
      && sameDesiredPublication(latest, activationRunId, intent)) {
      coalescedRows += 1;
      coalescedPublicationKeys.push(publicationKey(intent));
      continue;
    }
    await client.query(
      `UPDATE inventory.inventory_publication_outbox
       SET state = 'superseded', lease_token = NULL, lease_expires_at = NULL,
           last_error_class = 'SUPERSEDED_BY_NEWER_DESIRED_REVISION',
           last_error_message = 'A newer canonical runtime publication replaced this desired state.'
       WHERE publication_target_id = $1
         AND product_variant_id = $2
         AND publication_phase = 'full'
         AND state IN ('desired', 'queued', 'leased', 'retryable', 'drifted')`,
      [intent.publicationTargetId, intent.productVariantId],
    );
    const revision = (latest ? BigInt(latest.desired_revision) : BigInt(0)) + BigInt(1);
    const payload = persistedPublicationPayload(activationRunId, intent, revision.toString());
    const idempotencyKey = `availability:${activationRunId}:full:${intent.publicationTargetId}`
      + `:${intent.productVariantId}:${revision}`;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO inventory.inventory_publication_outbox (
         activation_run_id, publication_target_id, product_variant_id,
         desired_revision, desired_quantity, channel_connection_id_snapshot,
         external_scope_id_snapshot, external_inventory_item_id_snapshot,
         publication_phase, channel_id_snapshot, provider_key_snapshot,
         provider_scope_type_snapshot, external_sku_snapshot,
         publication_target_revision_snapshot,
         state, idempotency_key, payload_hash, available_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         'full', $9, $10, $11, $12, $13,
         'desired', $14, $15, transaction_timestamp()
       )
       RETURNING id`,
      [
        activationRunId,
        intent.publicationTargetId,
        intent.productVariantId,
        revision.toString(),
        intent.desiredQuantity,
        intent.channelConnectionId,
        intent.externalScopeId,
        intent.externalInventoryItemId,
        intent.channelId,
        intent.providerKey,
        intent.providerScopeType,
        intent.externalSku,
        intent.publicationTargetRevision,
        idempotencyKey,
        hash(payload),
      ],
    );
    if (inserted.rowCount !== 1 || !inserted.rows[0]?.id) {
      throw runtimeError(
        "INVENTORY_PUBLICATION_OUTBOX_INSERT_FAILED",
        "The canonical desired publication was not durably inserted.",
        { publicationTargetId: intent.publicationTargetId, productVariantId: intent.productVariantId },
      );
    }
    const queued = await client.query(
      `UPDATE inventory.inventory_publication_outbox
       SET state = 'queued'
       WHERE id = $1 AND state = 'desired'`,
      [inserted.rows[0].id],
    );
    if (queued.rowCount !== 1) {
      throw runtimeError(
        "INVENTORY_PUBLICATION_OUTBOX_QUEUE_FAILED",
        "The canonical desired publication could not enter the durable worker queue.",
        { outboxId: inserted.rows[0].id },
      );
    }
    enqueuedRows += 1;
    enqueuedPublicationKeys.push(publicationKey(intent));
  }
  if (enqueuedRows > 0) {
    await client.query(
      `UPDATE inventory.availability_activation_runs
       SET outbox_enqueued = true
       WHERE id = $1 AND state = 'active' AND outbox_enqueued = false`,
      [activationRunId],
    );
  }
  return {
    enqueuedRows,
    coalescedRows,
    enqueuedPublicationKeys,
    coalescedPublicationKeys,
  };
}

function publicationKey(intent: Pick<
  CanonicalInventoryPublicationIntent,
  "publicationTargetId" | "productVariantId"
>): string {
  return `${intent.publicationTargetId}:${intent.productVariantId}`;
}

function sameDesiredPublication(
  row: LatestPublicationRow,
  activationRunId: string,
  intent: CanonicalInventoryPublicationIntent,
): boolean {
  return String(row.activation_run_id) === activationRunId
    && String(row.desired_quantity) === intent.desiredQuantity
    && String(row.publication_target_revision_snapshot) === intent.publicationTargetRevision
    && Number(row.channel_id_snapshot) === intent.channelId
    && Number(row.channel_connection_id_snapshot) === intent.channelConnectionId
    && String(row.provider_key_snapshot) === intent.providerKey
    && String(row.provider_scope_type_snapshot) === intent.providerScopeType
    && String(row.external_scope_id_snapshot) === intent.externalScopeId
    && String(row.external_inventory_item_id_snapshot) === intent.externalInventoryItemId
    && (row.external_sku_snapshot == null ? null : String(row.external_sku_snapshot)) === intent.externalSku;
}

function reusablePublicationState(state: string): boolean {
  return [
    "desired",
    "queued",
    "leased",
    "acknowledged",
    "verified",
    "drifted",
    "retryable",
  ].includes(state);
}

function persistedPublicationPayload(
  activationRunId: string,
  intent: CanonicalInventoryPublicationIntent,
  desiredRevision: string,
): Record<string, unknown> {
  return {
    activationRunId,
    publicationPhase: "full",
    publicationTargetId: intent.publicationTargetId,
    publicationTargetRevision: intent.publicationTargetRevision,
    productVariantId: intent.productVariantId,
    desiredRevision,
    desiredQuantity: intent.desiredQuantity,
    channelId: intent.channelId,
    channelConnectionId: intent.channelConnectionId,
    providerKey: intent.providerKey,
    providerScopeType: intent.providerScopeType,
    externalScopeId: intent.externalScopeId,
    externalInventoryItemId: intent.externalInventoryItemId,
    externalSku: intent.externalSku,
  };
}

class AsyncSemaphore {
  private inUse = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<() => void> {
    if (this.inUse >= this.capacity) {
      return new Promise<() => void>((resolve) => this.waiters.push(resolve));
    }
    this.inUse += 1;
    return this.createRelease();
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(this.createRelease());
        return;
      }
      this.inUse -= 1;
    };
  }
}

function assertNestedConnectionCapacity(connectionPool: ClientPool): void {
  const max = connectionPool.options?.max ?? 10;
  if (!Number.isInteger(max) || max < 2) {
    throw runtimeError(
      "INVENTORY_PUBLICATION_POOL_CAPACITY_INVALID",
      "Inventory publication routing requires at least two database connections to pin legacy authority safely.",
      { max },
    );
  }
}

function routingConcurrency(connectionPool: ClientPool): number {
  return Math.max(1, Math.floor((connectionPool.options?.max ?? 10) / 2));
}

function runtimeError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): InventoryAvailabilityRuntimePublicationError {
  return new InventoryAvailabilityRuntimePublicationError(code, message, context);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw runtimeError(
      "INVENTORY_PUBLICATION_DATABASE_EVIDENCE_INVALID",
      `${field} must be a positive PostgreSQL integer.`,
      { field, value },
    );
  }
  return parsed;
}

function uniquePositiveIntegers(values: readonly number[], field: string): number[] {
  return [...new Set(values.map((value) => positiveInteger(value, field)))].sort((a, b) => a - b);
}

function positiveBigint(value: unknown): boolean {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function positiveBigintString(value: unknown, field: string): string {
  const parsed = String(value ?? "");
  if (!positiveBigint(parsed)) {
    throw runtimeError(
      "INVENTORY_PUBLICATION_DATABASE_EVIDENCE_INVALID",
      `${field} must be a positive PostgreSQL bigint.`,
      { field, value },
    );
  }
  return parsed;
}

function nonnegativeBigintString(value: unknown, field: string): string {
  const parsed = String(value ?? "");
  if (!/^(0|[1-9]\d*)$/.test(parsed)) {
    throw runtimeError(
      "INVENTORY_PUBLICATION_DATABASE_EVIDENCE_INVALID",
      `${field} must be a nonnegative PostgreSQL bigint.`,
      { field, value },
    );
  }
  return parsed;
}

function nullableNonnegativeBigintString(value: unknown, field: string): string | null {
  return value == null ? null : nonnegativeBigintString(value, field);
}

function nonblank(value: unknown, field: string, maximumLength: number): string {
  const parsed = typeof value === "string" ? value.trim() : "";
  if (parsed.length === 0 || parsed.length > maximumLength) {
    throw runtimeError(
      "INVENTORY_PUBLICATION_DATABASE_EVIDENCE_INVALID",
      `${field} must contain between 1 and ${maximumLength} characters.`,
      { field },
    );
  }
  return parsed;
}

function nullableNonblank(value: unknown, field: string, maximumLength: number): string | null {
  return value == null ? null : nonblank(value, field, maximumLength);
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value == null) return null;
  if (typeof value !== "boolean") {
    throw runtimeError(
      "INVENTORY_PUBLICATION_DATABASE_EVIDENCE_INVALID",
      `${field} must be a boolean or null.`,
      { field, value },
    );
  }
  return value;
}

function nullableBasisPoints(value: unknown, field: string): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw runtimeError(
      "INVENTORY_PUBLICATION_DATABASE_EVIDENCE_INVALID",
      `${field} must be between 0 and 10000 or null.`,
      { field, value },
    );
  }
  return parsed;
}

function nullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | null {
  if (value == null) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw runtimeError(
      "INVENTORY_PUBLICATION_DATABASE_EVIDENCE_INVALID",
      `${field} contains an unsupported value.`,
      { field, value },
    );
  }
  return value as T;
}

function providerScopeType(value: unknown): "account" | "location" {
  if (value !== "account" && value !== "location") {
    throw runtimeError(
      "INVENTORY_PUBLICATION_DATABASE_EVIDENCE_INVALID",
      "providerScopeType must be account or location.",
      { value },
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
