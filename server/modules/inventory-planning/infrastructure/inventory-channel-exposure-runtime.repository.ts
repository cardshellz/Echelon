import type { Pool, PoolClient } from "pg";

import type { SupplySnapshotDto } from "@shared/types/inventory-availability-planner";
import {
  channelExposurePolicyValueSchema,
  type ChannelExposurePolicyValue,
} from "@shared/types/inventory-channel-exposure";

import { pool as defaultPool } from "../../../db";
import {
  InventoryChannelExposureRuntimeError,
  InventoryChannelExposureRuntimeService,
  type ActiveChannelExposurePolicySnapshot,
  type ActiveInventoryPublicationTargetSnapshot,
  type ActivePublicationSourceBindingSnapshot,
  type ActivePublicationVariantMappingSnapshot,
  type InventoryChannelExposureRuntimeContext,
  type InventoryChannelExposureRuntimeExecutor,
  type InventoryChannelExposureRuntimeLogger,
} from "../application/inventory-channel-exposure-runtime.service";
import {
  channelExposurePolicyScopeKey,
  type ChannelExposurePolicyCandidate,
} from "../domain/inventory-channel-exposure";
import { loadAndLockRuntimeAuthority } from "./inventory-availability-runtime-atp.repository";
import { captureActiveSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";

type ClientPool = Pick<Pool, "connect">;
type SupplySnapshotCapture = (
  client: PoolClient,
  productId: number,
) => Promise<SupplySnapshotDto>;

interface PublicationTargetRow {
  publication_target_id: unknown;
  publication_target_revision: unknown;
  channel_id: unknown;
  channel_name: unknown;
  channel_provider: unknown;
  channel_connection_id: unknown;
  provider_scope_type: unknown;
  external_scope_id: unknown;
  publication_authority: unknown;
  publication_target_state: unknown;
}

interface SourceBindingRow {
  publication_target_id: unknown;
  binding_id: unknown;
  binding_version: unknown;
  binding_definition_hash: unknown;
  fulfillment_node_id: unknown;
  warehouse_id: unknown;
  fulfillment_node_lifecycle_status: unknown;
}

interface PolicyRow {
  channel_id: unknown;
  scope_key: unknown;
  policy_id: unknown;
  policy_version: unknown;
  policy_definition_hash: unknown;
  scope_type: unknown;
  product_id: unknown;
  product_variant_id: unknown;
  allocation_semantics: unknown;
  eligible: unknown;
  share_bps: unknown;
  holdback_sellable_units: unknown;
  max_publish_mode: unknown;
  max_publish_sellable_units: unknown;
  min_publish_sellable_units: unknown;
}

interface MappingRow {
  publication_target_id: unknown;
  product_variant_id: unknown;
  mapping_id: unknown;
  mapping_version: unknown;
  mapping_definition_hash: unknown;
  external_inventory_item_id: unknown;
  external_sku: unknown;
}

/**
 * Loads one snapshot-bound active-only channel-exposure context while holding the
 * same shared runtime-authority lock used by canonical ATP reads.
 */
export class PostgresInventoryChannelExposureRuntimeExecutor
implements InventoryChannelExposureRuntimeExecutor {
  constructor(
    private readonly connectionPool: ClientPool = defaultPool,
    private readonly captureSupplySnapshot: SupplySnapshotCapture =
      captureActiveSupplySnapshotInsideTransaction,
  ) {}

  async execute<T>(
    productId: number,
    work: (context: InventoryChannelExposureRuntimeContext) => Promise<T>,
  ): Promise<T> {
    const client = await this.connectionPool.connect();
    let began = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      began = true;
      const authority = await loadAndLockRuntimeAuthority(client);
      if (authority.authority === "legacy") {
        const result = await work({
          ...authority,
          supplySnapshot: null,
          managedSellableVariantIds: [],
          publicationTargets: [],
        });
        await client.query("COMMIT");
        began = false;
        return result;
      }

      const supplySnapshot = await this.captureSupplySnapshot(client, productId);
      const managedSellableVariantIds = await loadManagedSellableVariantIds(client, productId);
      const publicationTargets = await loadActivePublicationTargets(
        client,
        productId,
        managedSellableVariantIds,
      );
      const result = await work({
        ...authority,
        supplySnapshot,
        managedSellableVariantIds,
        publicationTargets,
      });
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Runtime channel-exposure planning and rollback both failed.",
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createInventoryChannelExposureRuntimeService(
  connectionPool: ClientPool = defaultPool,
  logger?: InventoryChannelExposureRuntimeLogger,
): InventoryChannelExposureRuntimeService {
  return new InventoryChannelExposureRuntimeService(
    new PostgresInventoryChannelExposureRuntimeExecutor(connectionPool),
    logger,
  );
}

export async function loadManagedSellableVariantIds(
  client: PoolClient,
  productId: number,
): Promise<number[]> {
  const result = await client.query<{ id: unknown }>(
    `SELECT id
     FROM catalog.product_variants
     WHERE product_id = $1
       AND is_active = true
       AND requires_shipping = true
       AND COALESCE(track_inventory, true) = true
       AND sales_eligibility = 'sellable'
     ORDER BY id`,
    [productId],
  );
  return result.rows.map((row) => positiveInteger(row.id, "productVariant.id"));
}

export async function loadActivePublicationTargets(
  client: PoolClient,
  productId: number,
  productVariantIds: readonly number[],
  channelId?: number,
): Promise<ActiveInventoryPublicationTargetSnapshot[]> {
  const targetValues: unknown[] = [];
  const channelFilter = channelId == null ? "" : "AND target.channel_id = $1";
  if (channelId != null) targetValues.push(positiveInteger(channelId, "channelId"));
  const targetResult = await client.query<PublicationTargetRow>(
    `SELECT target.id AS publication_target_id,
            target.revision::text AS publication_target_revision,
            target.channel_id,
            channel.name AS channel_name,
            channel.provider AS channel_provider,
            target.channel_connection_id,
            target.provider_scope_type,
            target.external_scope_id,
            target.publication_authority,
            target.state AS publication_target_state
     FROM inventory.inventory_publication_targets AS target
     JOIN channels.channels AS channel ON channel.id = target.channel_id
     WHERE target.state = 'live'
       AND target.publication_authority = 'echelon'
       ${channelFilter}
     ORDER BY target.id`,
    targetValues,
  );
  if (targetResult.rows.length === 0) return [];

  const targetIds = targetResult.rows.map((row) =>
    positiveInteger(row.publication_target_id, "publicationTarget.id"));
  const channelIds = [...new Set(targetResult.rows.map((row) =>
    positiveInteger(row.channel_id, "publicationTarget.channelId")))].sort((a, b) => a - b);
  const bindingResult = await client.query<SourceBindingRow>(
    `SELECT target.id AS publication_target_id,
            binding.id AS binding_id,
            binding.version AS binding_version,
            binding.definition_hash AS binding_definition_hash,
            member.fulfillment_node_id,
            node.warehouse_id,
            node.lifecycle_status AS fulfillment_node_lifecycle_status
     FROM inventory.inventory_publication_targets AS target
     LEFT JOIN inventory.publication_source_binding_heads AS head
       ON head.publication_target_id = target.id
     LEFT JOIN inventory.publication_source_binding_versions AS binding
       ON binding.id = head.active_binding_id
      AND binding.lifecycle_status = 'sealed'
     LEFT JOIN inventory.publication_source_binding_members AS member
       ON member.binding_id = binding.id
     LEFT JOIN warehouse.fulfillment_nodes AS node
       ON node.id = member.fulfillment_node_id
     WHERE target.id = ANY($1::integer[])
     ORDER BY target.id, member.priority`,
    [targetIds],
  );
  const policyResult = await client.query<PolicyRow>(
    `SELECT head.channel_id,
            head.scope_key,
            policy.id AS policy_id,
            policy.version AS policy_version,
            policy.definition_hash AS policy_definition_hash,
            policy.scope_type,
            policy.product_id,
            policy.product_variant_id,
            policy.allocation_semantics,
            policy.eligible,
            policy.share_bps,
            policy.holdback_sellable_units::text AS holdback_sellable_units,
            policy.max_publish_mode,
            policy.max_publish_sellable_units::text AS max_publish_sellable_units,
            policy.min_publish_sellable_units::text AS min_publish_sellable_units
     FROM inventory.channel_exposure_policy_heads AS head
     JOIN inventory.channel_exposure_policy_versions AS policy
       ON policy.id = head.active_policy_id
      AND policy.lifecycle_status = 'sealed'
     WHERE head.channel_id = ANY($1::integer[])
       AND (policy.scope_type = 'channel' OR policy.product_id = $2)
     ORDER BY head.channel_id, head.scope_key`,
    [channelIds, productId],
  );
  const mappingResult = productVariantIds.length === 0
    ? { rows: [] as MappingRow[] }
    : await client.query<MappingRow>(
          `SELECT head.publication_target_id,
                  head.product_variant_id,
                  mapping.id AS mapping_id,
                  mapping.version AS mapping_version,
                  mapping.definition_hash AS mapping_definition_hash,
                  mapping.external_inventory_item_id,
                  mapping.external_sku
           FROM inventory.publication_variant_mapping_heads AS head
           JOIN inventory.publication_variant_mapping_versions AS mapping
             ON mapping.id = head.active_mapping_id
            AND mapping.lifecycle_status = 'sealed'
           WHERE head.publication_target_id = ANY($1::integer[])
             AND head.product_variant_id = ANY($2::integer[])
           ORDER BY head.publication_target_id, head.product_variant_id`,
        [targetIds, productVariantIds],
      );

  const bindings = mapBindings(bindingResult.rows);
  const policies = groupPoliciesByChannel(policyResult.rows, productId);
  const mappings = groupMappingsByTarget(mappingResult.rows);
  return targetResult.rows.map((row): ActiveInventoryPublicationTargetSnapshot => {
    const publicationTargetId = positiveInteger(row.publication_target_id, "publicationTarget.id");
    const channelId = positiveInteger(row.channel_id, "publicationTarget.channelId");
    return {
      publicationTargetId,
      publicationTargetRevision: positiveBigintString(
        row.publication_target_revision,
        "publicationTarget.revision",
      ),
      channelId,
      channelName: nonblank(row.channel_name, "publicationTarget.channelName"),
      channelProvider: nonblank(row.channel_provider, "publicationTarget.channelProvider"),
      channelConnectionId: positiveInteger(
        row.channel_connection_id,
        "publicationTarget.channelConnectionId",
      ),
      providerScopeType: providerScopeType(row.provider_scope_type),
      externalScopeId: nonblank(row.external_scope_id, "publicationTarget.externalScopeId"),
      publicationAuthority: literal(row.publication_authority, "echelon", "publicationTarget.authority"),
      publicationTargetState: literal(row.publication_target_state, "live", "publicationTarget.state"),
      sourceBinding: bindings.get(publicationTargetId) ?? null,
      policies: policies.get(channelId) ?? [],
      mappings: mappings.get(publicationTargetId) ?? [],
    };
  });
}

function mapBindings(rows: readonly SourceBindingRow[]): Map<number, ActivePublicationSourceBindingSnapshot> {
  const result = new Map<number, ActivePublicationSourceBindingSnapshot>();
  for (const row of rows) {
    const publicationTargetId = positiveInteger(row.publication_target_id, "sourceBinding.targetId");
    if (row.binding_id == null) continue;
    const existing = result.get(publicationTargetId);
    const bindingId = positiveInteger(row.binding_id, "sourceBinding.id");
    const binding = existing ?? {
      bindingId,
      version: positiveInteger(row.binding_version, "sourceBinding.version"),
      definitionHash: sha256(row.binding_definition_hash, "sourceBinding.definitionHash"),
      members: [],
    };
    if (binding.bindingId !== bindingId) {
      throw invalidRow("More than one active source binding resolved for a publication target.", {
        publicationTargetId,
        bindingIds: [binding.bindingId, bindingId],
      });
    }
    if (row.fulfillment_node_id != null || row.warehouse_id != null
      || row.fulfillment_node_lifecycle_status != null) {
      if (row.fulfillment_node_id == null || row.warehouse_id == null
        || row.fulfillment_node_lifecycle_status == null) {
        throw invalidRow("Source-binding member evidence is only partially populated.", {
          publicationTargetId,
          bindingId,
        });
      }
      binding.members = [...binding.members, {
        fulfillmentNodeId: positiveInteger(row.fulfillment_node_id, "sourceBinding.nodeId"),
        warehouseId: positiveInteger(row.warehouse_id, "sourceBinding.warehouseId"),
        fulfillmentNodeLifecycleStatus: lifecycleStatus(row.fulfillment_node_lifecycle_status),
      }];
    }
    result.set(publicationTargetId, binding);
  }
  return result;
}

function groupPoliciesByChannel(
  rows: readonly PolicyRow[],
  productId: number,
): Map<number, ActiveChannelExposurePolicySnapshot[]> {
  const result = new Map<number, ActiveChannelExposurePolicySnapshot[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const channelId = positiveInteger(row.channel_id, "policy.channelId");
    const scopeType = policyScopeType(row.scope_type);
    if ((scopeType === "channel" && (row.product_id != null || row.product_variant_id != null))
      || (scopeType === "product" && row.product_variant_id != null)) {
      throw invalidRow("An active channel-exposure policy has invalid scope members.", {
        channelId,
        scopeType,
        productId: row.product_id,
        productVariantId: row.product_variant_id,
      });
    }
    const scope = scopeType === "channel"
      ? { scopeType, channelId } as const
      : scopeType === "product"
        ? {
            scopeType,
            channelId,
            productId: positiveInteger(row.product_id, "policy.productId"),
          } as const
        : {
            scopeType,
            channelId,
            productId: positiveInteger(row.product_id, "policy.productId"),
            productVariantId: positiveInteger(row.product_variant_id, "policy.productVariantId"),
          } as const;
    if (scopeType !== "channel" && scope.productId !== productId) {
      throw invalidRow("An active channel-exposure policy belongs to the wrong product.", {
        requestedProductId: productId,
        policyProductId: scope.productId,
      });
    }
    const scopeKey = nonblank(row.scope_key, "policy.scopeKey");
    if (scopeKey !== channelExposurePolicyScopeKey(scope)) {
      throw invalidRow("An active channel-exposure policy has an invalid scope key.", {
        scopeKey,
        expectedScopeKey: channelExposurePolicyScopeKey(scope),
      });
    }
    const uniqueKey = `${channelId}:${scopeKey}`;
    if (seen.has(uniqueKey)) {
      throw invalidRow("More than one active channel-exposure policy resolved for a scope.", {
        channelId,
        scopeKey,
      });
    }
    seen.add(uniqueKey);
    const policy: ActiveChannelExposurePolicySnapshot = {
      scopeKey,
      scopeType,
      policyId: positiveInteger(row.policy_id, "policy.id"),
      version: positiveInteger(row.policy_version, "policy.version"),
      definitionHash: sha256(row.policy_definition_hash, "policy.definitionHash"),
      value: activePolicyValue({
        allocationSemantics: row.allocation_semantics,
        eligible: row.eligible,
        shareBps: row.share_bps,
        holdbackSellableUnits: row.holdback_sellable_units,
        maxPublishMode: row.max_publish_mode,
        maxPublishSellableUnits: row.max_publish_sellable_units,
        minPublishSellableUnits: row.min_publish_sellable_units,
      }),
    };
    result.set(channelId, [...(result.get(channelId) ?? []), policy]);
  }
  for (const values of result.values()) values.sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
  return result;
}

function groupMappingsByTarget(
  rows: readonly MappingRow[],
): Map<number, ActivePublicationVariantMappingSnapshot[]> {
  const result = new Map<number, ActivePublicationVariantMappingSnapshot[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const publicationTargetId = positiveInteger(row.publication_target_id, "mapping.targetId");
    const productVariantId = positiveInteger(row.product_variant_id, "mapping.variantId");
    const uniqueKey = `${publicationTargetId}:${productVariantId}`;
    if (seen.has(uniqueKey)) {
      throw invalidRow("More than one active provider mapping resolved for a target SKU.", {
        publicationTargetId,
        productVariantId,
      });
    }
    seen.add(uniqueKey);
    const mapping: ActivePublicationVariantMappingSnapshot = {
      mappingId: positiveInteger(row.mapping_id, "mapping.id"),
      productVariantId,
      version: positiveInteger(row.mapping_version, "mapping.version"),
      definitionHash: sha256(row.mapping_definition_hash, "mapping.definitionHash"),
      externalInventoryItemId: nonblank(row.external_inventory_item_id, "mapping.externalInventoryItemId"),
      externalSku: nullableNonblank(row.external_sku, "mapping.externalSku"),
    };
    result.set(publicationTargetId, [...(result.get(publicationTargetId) ?? []), mapping]);
  }
  for (const values of result.values()) {
    values.sort((left, right) => left.productVariantId - right.productVariantId);
  }
  return result;
}

function activePolicyValue(input: {
  allocationSemantics: unknown;
  eligible: unknown;
  shareBps: unknown;
  holdbackSellableUnits: unknown;
  maxPublishMode: unknown;
  maxPublishSellableUnits: unknown;
  minPublishSellableUnits: unknown;
}): ChannelExposurePolicyValue {
  try {
    return channelExposurePolicyValueSchema.parse({
      allocationSemantics: input.allocationSemantics == null
        ? null : String(input.allocationSemantics),
      eligible: input.eligible == null ? null : input.eligible,
      shareBps: input.shareBps == null ? null : Number(input.shareBps),
      holdbackSellableUnits: input.holdbackSellableUnits == null
        ? null : String(input.holdbackSellableUnits),
      maxPublish: input.maxPublishMode == null
        ? null
        : input.maxPublishMode === "unlimited"
          ? { mode: "unlimited" }
          : { mode: "units", units: String(input.maxPublishSellableUnits) },
      minPublishSellableUnits: input.minPublishSellableUnits == null
        ? null : String(input.minPublishSellableUnits),
    });
  } catch (error) {
    throw new InventoryChannelExposureRuntimeError(
      "CANONICAL_CHANNEL_EXPOSURE_DATABASE_EVIDENCE_INVALID",
      "An active channel-exposure policy value is malformed.",
      { input },
      { cause: error },
    );
  }
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw invalidRow(`${field} must be a positive PostgreSQL integer.`, { field, value });
  }
  return parsed;
}

function positiveBigintString(value: unknown, field: string): string {
  const parsed = String(value);
  if (!/^[1-9][0-9]*$/.test(parsed)) {
    throw invalidRow(`${field} must be a positive PostgreSQL bigint.`, { field, value });
  }
  return parsed;
}

function nonblank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidRow(`${field} must be nonblank.`, { field });
  }
  return value.trim();
}

function nullableNonblank(value: unknown, field: string): string | null {
  return value == null ? null : nonblank(value, field);
}

function sha256(value: unknown, field: string): string {
  const parsed = String(value);
  if (!/^[0-9a-f]{64}$/.test(parsed)) {
    throw invalidRow(`${field} must be a lowercase SHA-256 digest.`, { field, value });
  }
  return parsed;
}

function providerScopeType(value: unknown): "account" | "location" {
  if (value !== "account" && value !== "location") {
    throw invalidRow("Publication target provider scope is invalid.", { value });
  }
  return value;
}

function lifecycleStatus(value: unknown): "draft" | "active" | "retired" {
  if (value !== "draft" && value !== "active" && value !== "retired") {
    throw invalidRow("Fulfillment-node lifecycle status is invalid.", { value });
  }
  return value;
}

function policyScopeType(value: unknown): ChannelExposurePolicyCandidate["scopeType"] {
  if (value !== "channel" && value !== "product" && value !== "variant") {
    throw invalidRow("Channel-exposure policy scope is invalid.", { value });
  }
  return value;
}

function literal<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw invalidRow(`${field} must equal ${expected}.`, { field, value });
  return expected;
}

function invalidRow(message: string, context: Record<string, unknown>) {
  return new InventoryChannelExposureRuntimeError(
    "CANONICAL_CHANNEL_EXPOSURE_DATABASE_EVIDENCE_INVALID",
    message,
    context,
  );
}
