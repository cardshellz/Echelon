import { eq, sql } from "drizzle-orm";

import {
  channelExposurePolicyHeads,
  channelExposurePolicyVersions,
  idempotencyKeys,
  inventoryPublicationTargets,
  publicationSourceBindingHeads,
  publicationSourceBindingMembers,
  publicationSourceBindingVersions,
  publicationVariantMappingHeads,
  publicationVariantMappingVersions,
} from "@shared/schema";
import {
  channelExposureDraftSaveResultSchema,
  inventoryChannelExposureAdminViewSchema,
  inventoryChannelExposurePreviewSchema,
  inventoryPublicationTargetCommandResultSchema,
  type ChannelExposureDraftSaveResult,
  type ChannelExposurePolicyHead,
  type ChannelExposurePolicyScope,
  type ChannelExposurePolicyValue,
  type ChannelExposurePolicyVersion,
  type InventoryChannelExposureAdminView,
  type InventoryChannelExposurePreview,
  type InventoryPublicationTargetCommandResult,
  type PublicationSourceBindingHead,
  type PublicationSourceBindingVersion,
  type PublicationVariantMappingHead,
  type PublicationVariantMappingVersion,
} from "@shared/types/inventory-channel-exposure";

import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import { sqlIntegerArray } from "../../../infrastructure/postgres-array";
import type {
  InventoryChannelExposureAdminStore,
  CreateInventoryPublicationTargetCommand,
  SaveChannelExposurePolicyDraftCommand,
  SavePublicationSourceBindingDraftCommand,
  SavePublicationVariantMappingDraftCommand,
  SetInventoryPublicationTargetPreviewStateCommand,
} from "../application/inventory-channel-exposure-admin.service";
import {
  calculateChannelExposure,
  calculateChannelExposureDefinitionHash,
  calculatePublicationSourceBindingDefinitionHash,
  calculatePublicationVariantMappingDefinitionHash,
  channelExposurePolicyScopeKey,
  resolveChannelExposurePolicy,
  type ChannelExposurePolicyCandidate,
} from "../domain/inventory-channel-exposure";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import {
  PostgresInventoryAvailabilityShadowRepository,
  type InventoryAvailabilityShadowStore,
} from "./inventory-availability-shadow.repository";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const IDEMPOTENCY_LOCK_NAMESPACE = 918420;
const POLICY_LOCK_NAMESPACE = 918425;
const SOURCE_BINDING_LOCK_NAMESPACE = 918426;
const PUBLICATION_TARGET_LOCK_NAMESPACE = 918427;
const VARIANT_MAPPING_LOCK_NAMESPACE = 918428;
const POLICY_RECEIPT_PREFIX = "inventory-channel-exposure-policy:";
const SOURCE_RECEIPT_PREFIX = "inventory-publication-source-binding:";
const TARGET_RECEIPT_PREFIX = "inventory-publication-target:";
const VARIANT_MAPPING_RECEIPT_PREFIX = "inventory-publication-variant-mapping:";

export class PostgresInventoryChannelExposureAdminStore
implements InventoryChannelExposureAdminStore {
  constructor(
    private readonly database: typeof db = db,
    private readonly shadowStore: InventoryAvailabilityShadowStore =
      new PostgresInventoryAvailabilityShadowRepository(),
  ) {}

  async getAdminView(productId: number | null): Promise<InventoryChannelExposureAdminView> {
    const productRows = rows(await this.database.execute(sql`
      SELECT product.id, product.sku, product.name
      FROM catalog.products AS product
      WHERE product.is_active = true
        AND EXISTS (
          SELECT 1 FROM catalog.product_variants AS variant
          WHERE variant.product_id = product.id
            AND variant.requires_shipping = true
            AND COALESCE(variant.track_inventory, true) = true
        )
      ORDER BY product.name, product.id
    `));
    const selectedProductRow = productId === null ? null : productRows.find((row) =>
      positiveInteger(row.id, "product.id") === productId) ?? null;
    if (productId !== null && !selectedProductRow) {
      throw new InventoryAvailabilityMasterDataError(
        404,
        "INVENTORY_CHANNEL_EXPOSURE_PRODUCT_NOT_FOUND",
        "The selected channel-exposure product was not found.",
      );
    }
    const variantRows = productId === null ? [] : rows(await this.database.execute(sql`
      SELECT id, sku, name, units_per_variant, sales_eligibility, is_active
      FROM catalog.product_variants
      WHERE product_id = ${productId}
        AND requires_shipping = true
        AND COALESCE(track_inventory, true) = true
      ORDER BY units_per_variant, id
    `));
    const channelRows = rows(await this.database.execute(sql`
      SELECT id, name, provider, status
      FROM channels.channels
      ORDER BY name, id
    `));
    const connectionRows = rows(await this.database.execute(sql`
      SELECT id, channel_id, shop_domain
      FROM channels.channel_connections
      ORDER BY channel_id, id
    `));
    const dropshipStoreRows = rows(await this.database.execute(sql`
      SELECT connection.id, connection.vendor_id, vendor.business_name AS vendor_name,
             connection.platform, connection.status,
             COALESCE(connection.external_display_name, connection.external_account_id,
               connection.shop_domain) AS external_account_label
      FROM dropship.dropship_store_connections AS connection
      JOIN dropship.dropship_vendors AS vendor ON vendor.id = connection.vendor_id
      ORDER BY vendor.business_name, connection.platform, connection.id
    `));
    const targetRows = rows(await this.database.execute(sql`
      SELECT id, destination_kind, channel_id, channel_connection_id,
             dropship_store_connection_id, fulfillment_node_id,
             provider_scope_type, external_scope_id, publication_authority, state, revision
      FROM inventory.inventory_publication_targets
      ORDER BY channel_id, destination_kind, channel_connection_id,
               dropship_store_connection_id, external_scope_id, id
    `));
    const nodeRows = rows(await this.database.execute(sql`
      SELECT node.id, node.code, node.name, node.node_type, node.warehouse_id,
             warehouse.code AS warehouse_code, node.lifecycle_status
      FROM warehouse.fulfillment_nodes AS node
      JOIN warehouse.warehouses AS warehouse ON warehouse.id = node.warehouse_id
      WHERE node.lifecycle_status <> 'retired'
      ORDER BY node.code, node.id
    `));
    const policyRows = rows(await this.database.execute(sql`
      SELECT head.scope_key, head.channel_id, head.revision, pointer.pointer_type,
             policy.id AS policy_id, policy.version, policy.lifecycle_status,
             policy.scope_type, policy.product_id, policy.product_variant_id,
             policy.allocation_semantics, policy.eligible, policy.share_bps,
             policy.holdback_sellable_units, policy.max_publish_mode,
             policy.max_publish_sellable_units, policy.min_publish_sellable_units,
             policy.definition_hash, policy.change_reason, policy.created_by,
             policy.created_at, policy.updated_at
      FROM inventory.channel_exposure_policy_heads AS head
      CROSS JOIN LATERAL (
        VALUES ('active', head.active_policy_id), ('draft', head.draft_policy_id)
      ) AS pointer(pointer_type, policy_id)
      JOIN inventory.channel_exposure_policy_versions AS policy ON policy.id = pointer.policy_id
      WHERE policy.scope_type = 'channel'
         OR (${productId}::integer IS NOT NULL AND policy.product_id = ${productId})
      ORDER BY head.scope_key, pointer.pointer_type
    `));
    const bindingRows = rows(await this.database.execute(sql`
      SELECT head.publication_target_id, head.revision, pointer.pointer_type,
             binding.id AS binding_id, binding.version, binding.lifecycle_status,
             binding.definition_hash, binding.change_reason, binding.created_by,
             binding.created_at, binding.updated_at,
             member.fulfillment_node_id, member.priority
      FROM inventory.publication_source_binding_heads AS head
      CROSS JOIN LATERAL (
        VALUES ('active', head.active_binding_id), ('draft', head.draft_binding_id)
      ) AS pointer(pointer_type, binding_id)
      JOIN inventory.publication_source_binding_versions AS binding ON binding.id = pointer.binding_id
      LEFT JOIN inventory.publication_source_binding_members AS member ON member.binding_id = binding.id
      ORDER BY head.publication_target_id, pointer.pointer_type, member.priority
    `));
    const mappingRows = productId === null ? [] : rows(await this.database.execute(sql`
      SELECT head.publication_target_id, head.product_variant_id, head.revision,
             pointer.pointer_type, mapping.id AS mapping_id, mapping.version,
             mapping.lifecycle_status, mapping.external_inventory_item_id,
             mapping.external_sku, mapping.definition_hash, mapping.change_reason,
             mapping.created_by, mapping.created_at, mapping.updated_at
      FROM inventory.publication_variant_mapping_heads AS head
      CROSS JOIN LATERAL (
        VALUES ('active', head.active_mapping_id), ('draft', head.draft_mapping_id)
      ) AS pointer(pointer_type, mapping_id)
      JOIN inventory.publication_variant_mapping_versions AS mapping ON mapping.id = pointer.mapping_id
      JOIN catalog.product_variants AS variant ON variant.id = head.product_variant_id
      WHERE variant.product_id = ${productId}
      ORDER BY head.publication_target_id, head.product_variant_id, pointer.pointer_type
    `));
    const legacyMappingRows = productId === null ? [] : rows(await this.database.execute(sql`
      SELECT feed.id AS feed_id, feed.channel_id, feed.product_variant_id,
             feed.is_active, feed.quarantined_at,
             feed.channel_inventory_item_id, COALESCE(feed.channel_sku, listing.external_sku) AS external_sku
      FROM channels.channel_feeds AS feed
      JOIN catalog.product_variants AS variant ON variant.id = feed.product_variant_id
      LEFT JOIN channels.channel_listings AS listing
        ON listing.channel_id = feed.channel_id
       AND listing.product_variant_id = feed.product_variant_id
      WHERE variant.product_id = ${productId}
      ORDER BY feed.channel_id, feed.product_variant_id, feed.id
    `));
    const connectionsByChannel = groupBy(connectionRows, (row) => positiveInteger(row.channel_id, "connection.channelId"));

    return inventoryChannelExposureAdminViewSchema.parse({
      products: productRows.map((row) => ({
        id: positiveInteger(row.id, "product.id"),
        sku: nullableText(row.sku),
        name: String(row.name),
      })),
      selectedProduct: selectedProductRow ? {
        id: positiveInteger(selectedProductRow.id, "selectedProduct.id"),
        sku: nullableText(selectedProductRow.sku),
        name: String(selectedProductRow.name),
        variants: variantRows.map((row) => ({
          id: positiveInteger(row.id, "variant.id"),
          sku: nullableText(row.sku),
          name: String(row.name),
          unitsPerVariant: positiveInteger(row.units_per_variant, "variant.unitsPerVariant"),
          salesEligibility: String(row.sales_eligibility),
          isActive: Boolean(row.is_active),
        })),
      } : null,
      channels: channelRows.map((row) => {
        const channelId = positiveInteger(row.id, "channel.id");
        return {
          id: channelId,
          name: String(row.name),
          provider: String(row.provider),
          status: String(row.status),
          connections: (connectionsByChannel.get(channelId) ?? []).map((connection) => ({
            id: positiveInteger(connection.id, "connection.id"),
            externalAccountLabel: nullableText(connection.shop_domain),
          })),
        };
      }),
      dropshipStores: dropshipStoreRows.map((row) => ({
        id: positiveInteger(row.id, "dropshipStore.id"),
        vendorId: positiveInteger(row.vendor_id, "dropshipStore.vendorId"),
        vendorName: String(row.vendor_name),
        platform: String(row.platform),
        status: String(row.status),
        externalAccountLabel: nullableText(row.external_account_label),
      })),
      publicationTargets: targetRows.map((row) => ({
        id: positiveInteger(row.id, "target.id"),
        destinationKind: String(row.destination_kind),
        channelId: positiveInteger(row.channel_id, "target.channelId"),
        channelConnectionId: nullablePositiveInteger(row.channel_connection_id, "target.connectionId"),
        dropshipStoreConnectionId: nullablePositiveInteger(
          row.dropship_store_connection_id,
          "target.dropshipStoreConnectionId",
        ),
        legacyFulfillmentNodeId: positiveInteger(row.fulfillment_node_id, "target.legacyNodeId"),
        providerScopeType: String(row.provider_scope_type),
        externalScopeId: String(row.external_scope_id),
        publicationAuthority: String(row.publication_authority),
        state: String(row.state),
        revision: String(row.revision),
      })),
      fulfillmentNodes: nodeRows.map((row) => ({
        id: positiveInteger(row.id, "node.id"),
        code: String(row.code),
        name: String(row.name),
        nodeType: String(row.node_type),
        warehouseId: positiveInteger(row.warehouse_id, "node.warehouseId"),
        warehouseCode: String(row.warehouse_code),
        lifecycleStatus: String(row.lifecycle_status),
      })),
      policyHeads: mapPolicyHeads(policyRows),
      sourceBindingHeads: mapBindingHeads(bindingRows),
      variantMappingHeads: mapVariantMappingHeads(mappingRows),
      legacyMappingCandidates: legacyMappingRows.map((row) => ({
        channelId: positiveInteger(row.channel_id, "legacyMapping.channelId"),
        productVariantId: positiveInteger(row.product_variant_id, "legacyMapping.variantId"),
        feedId: positiveInteger(row.feed_id, "legacyMapping.feedId"),
        mappingState: row.quarantined_at != null ? "quarantined" as const
          : Number(row.is_active) === 1 ? "active" as const : "inactive" as const,
        externalInventoryItemId: nullableText(row.channel_inventory_item_id),
        externalSku: nullableText(row.external_sku),
      })),
      runtimeAuthority: "legacy_channel_allocation_rules",
      providerWriteEnabled: false,
    });
  }

  async createPublicationTarget(
    command: CreateInventoryPublicationTargetCommand,
  ): Promise<InventoryPublicationTargetCommandResult> {
    return this.database.transaction(async (tx) => {
      const receiptKey = `${TARGET_RECEIPT_PREFIX}${command.idempotencyKey}`;
      await lockIdempotency(tx, command.idempotencyKey);
      const replay = await loadTargetReplay(tx, receiptKey, command.requestHash);
      if (replay) return replay;
      await insertReceipt(tx, receiptKey, command.requestHash, command.occurredAt);
      await validatePublicationTarget(tx, command);
      const destinationId = command.destinationKind === "channel_connection"
        ? command.channelConnectionId!
        : command.dropshipStoreConnectionId!;
      const identityKey = [
        command.destinationKind,
        destinationId,
        command.providerScopeType,
        command.externalScopeId,
      ].join(":");
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(${PUBLICATION_TARGET_LOCK_NAMESPACE}, hashtext(${identityKey}))
      `);
      const duplicateRows = rows(await tx.execute(command.destinationKind === "channel_connection"
        ? sql`
            SELECT id
            FROM inventory.inventory_publication_targets
            WHERE destination_kind = 'channel_connection'
              AND channel_connection_id = ${command.channelConnectionId}
              AND provider_scope_type = ${command.providerScopeType}
              AND external_scope_id = ${command.externalScopeId}
            FOR SHARE
          `
        : sql`
            SELECT id
            FROM inventory.inventory_publication_targets
            WHERE destination_kind = 'dropship_store_connection'
              AND dropship_store_connection_id = ${command.dropshipStoreConnectionId}
              AND provider_scope_type = ${command.providerScopeType}
              AND external_scope_id = ${command.externalScopeId}
            FOR SHARE
          `));
      if (duplicateRows.length > 0) {
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_PUBLICATION_TARGET_ALREADY_EXISTS",
          "This provider destination already has an exact publication target.",
        );
      }
      const inserted = await tx.insert(inventoryPublicationTargets).values({
        destinationKind: command.destinationKind,
        channelId: command.channelId,
        channelConnectionId: command.channelConnectionId,
        dropshipStoreConnectionId: command.dropshipStoreConnectionId,
        fulfillmentNodeId: command.legacyFulfillmentNodeId,
        providerScopeType: command.providerScopeType,
        externalScopeId: command.externalScopeId,
        publicationAuthority: command.publicationAuthority,
        state: "disabled",
        changeReason: command.changeReason,
        createdBy: command.actorId,
        activatedBy: null,
        activatedAt: null,
        revision: BigInt(1),
        createdAt: command.occurredAt,
        updatedAt: command.occurredAt,
      }).returning({ id: inventoryPublicationTargets.id });
      const publicationTargetId = inserted[0]!.id;
      const result = inventoryPublicationTargetCommandResultSchema.parse({
        publicationTargetId,
        revision: "1",
        state: "disabled",
        alreadyApplied: false,
        runtimeAuthorityChanged: false,
        providerWriteAttempted: false,
        outboxEnqueued: false,
      });
      await persistAuditEvent(tx, {
        actor: command.actorId,
        action: "inventory_availability.publication_target.created_disabled",
        target: `inventory.inventory_publication_target:${publicationTargetId}`,
        changes: { before: null, after: {
          destinationKind: command.destinationKind,
          channelId: command.channelId,
          channelConnectionId: command.channelConnectionId,
          dropshipStoreConnectionId: command.dropshipStoreConnectionId,
          legacyFulfillmentNodeId: command.legacyFulfillmentNodeId,
          providerScopeType: command.providerScopeType,
          externalScopeId: command.externalScopeId,
          publicationAuthority: command.publicationAuthority,
          state: "disabled",
        } },
        context: { idempotencyKey: command.idempotencyKey, requestHash: command.requestHash,
          runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false },
      }, { timestamp: command.occurredAt, emitStructuredLog: false });
      await completeTargetReceipt(tx, receiptKey, "inventory_publication_target_create", result);
      return result;
    });
  }

  async setPublicationTargetPreviewState(
    command: SetInventoryPublicationTargetPreviewStateCommand,
  ): Promise<InventoryPublicationTargetCommandResult> {
    return this.database.transaction(async (tx) => {
      const receiptKey = `${TARGET_RECEIPT_PREFIX}${command.idempotencyKey}`;
      await lockIdempotency(tx, command.idempotencyKey);
      const replay = await loadTargetReplay(tx, receiptKey, command.requestHash);
      if (replay) return replay;
      await insertReceipt(tx, receiptKey, command.requestHash, command.occurredAt);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(${PUBLICATION_TARGET_LOCK_NAMESPACE}, ${command.publicationTargetId})
      `);
      const targetRows = rows(await tx.execute(sql`
        SELECT id, state, revision
        FROM inventory.inventory_publication_targets
        WHERE id = ${command.publicationTargetId}
        FOR UPDATE
      `));
      const target = targetRows[0];
      if (!target) {
        throw new InventoryAvailabilityMasterDataError(
          404,
          "INVENTORY_CHANNEL_EXPOSURE_TARGET_NOT_FOUND",
          "The selected publication target does not exist.",
        );
      }
      if (String(target.revision) !== command.expectedRevision) {
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_PUBLICATION_TARGET_STALE",
          "The publication target changed. Reload it before changing preview state.",
        );
      }
      const previousState = String(target.state);
      if (previousState === "live") {
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_PUBLICATION_TARGET_LIVE",
          "This readiness command cannot change a live publication target.",
        );
      }
      if (previousState === command.state) {
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_PUBLICATION_TARGET_STATE_UNCHANGED",
          "The publication target is already in the requested state.",
        );
      }
      await tx.update(inventoryPublicationTargets).set({
        state: command.state,
        activatedBy: command.state === "preview" ? command.actorId : null,
        activatedAt: command.state === "preview" ? command.occurredAt : null,
        revision: sql`${inventoryPublicationTargets.revision} + 1`,
        updatedAt: command.occurredAt,
      }).where(eq(inventoryPublicationTargets.id, command.publicationTargetId));
      const result = inventoryPublicationTargetCommandResultSchema.parse({
        publicationTargetId: command.publicationTargetId,
        revision: (BigInt(command.expectedRevision) + BigInt(1)).toString(),
        state: command.state,
        alreadyApplied: false,
        runtimeAuthorityChanged: false,
        providerWriteAttempted: false,
        outboxEnqueued: false,
      });
      await persistAuditEvent(tx, {
        actor: command.actorId,
        action: "inventory_availability.publication_target.preview_state_changed",
        target: `inventory.inventory_publication_target:${command.publicationTargetId}`,
        changes: { before: { state: previousState }, after: { state: command.state } },
        context: { reason: command.changeReason, idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash, runtimeAuthorityChanged: false,
          providerWriteAttempted: false, outboxEnqueued: false },
      }, { timestamp: command.occurredAt, emitStructuredLog: false });
      await completeTargetReceipt(tx, receiptKey, "inventory_publication_target_preview_state", result);
      return result;
    });
  }

  async saveVariantMappingDraft(
    command: SavePublicationVariantMappingDraftCommand,
  ): Promise<ChannelExposureDraftSaveResult> {
    return this.database.transaction(async (tx) => {
      const receiptKey = `${VARIANT_MAPPING_RECEIPT_PREFIX}${command.idempotencyKey}`;
      await lockIdempotency(tx, command.idempotencyKey);
      const replay = await loadReplay(tx, receiptKey, command.requestHash);
      if (replay) return replay;
      await insertReceipt(tx, receiptKey, command.requestHash, command.occurredAt);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(${VARIANT_MAPPING_LOCK_NAMESPACE}, ${command.publicationTargetId})
      `);
      await validateVariantMapping(tx, command.publicationTargetId, command.productVariantId);
      const identityConflict = rows(await tx.execute(sql`
        SELECT head.product_variant_id
        FROM inventory.publication_variant_mapping_heads AS head
        JOIN inventory.publication_variant_mapping_versions AS mapping
          ON mapping.id = COALESCE(head.draft_mapping_id, head.active_mapping_id)
        WHERE head.publication_target_id = ${command.publicationTargetId}
          AND head.product_variant_id <> ${command.productVariantId}
          AND mapping.external_inventory_item_id = ${command.externalInventoryItemId}
        LIMIT 1
      `))[0];
      if (identityConflict) {
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT",
          "This provider inventory item is already mapped to another SKU in the exact publication target.",
          [`productVariantId: ${positiveInteger(identityConflict.product_variant_id, "mappingConflict.variantId")}`],
        );
      }
      const headRows = rows(await tx.execute(sql`
        SELECT publication_target_id, product_variant_id, revision,
               active_mapping_id, draft_mapping_id
        FROM inventory.publication_variant_mapping_heads
        WHERE publication_target_id = ${command.publicationTargetId}
          AND product_variant_id = ${command.productVariantId}
        FOR UPDATE
      `));
      const head = headRows[0] ?? null;
      assertExpectedVariantMappingHead(head, command);
      const definitionHash = calculatePublicationVariantMappingDefinitionHash({
        publicationTargetId: command.publicationTargetId,
        productVariantId: command.productVariantId,
        externalInventoryItemId: command.externalInventoryItemId,
        externalSku: command.externalSku,
      });
      let definitionId: number;
      let version: number;
      if (head?.draft_mapping_id != null) {
        definitionId = positiveInteger(head.draft_mapping_id, "variantMappingHead.draftMappingId");
        const draftRows = rows(await tx.execute(sql`
          SELECT id, version, definition_hash
          FROM inventory.publication_variant_mapping_versions
          WHERE id = ${definitionId}
          FOR UPDATE
        `));
        const draft = draftRows[0];
        if (!draft || String(draft.definition_hash) !== command.expectedDraftDefinitionHash) {
          throw staleVariantMapping();
        }
        version = positiveInteger(draft.version, "variantMapping.version");
        await tx.update(publicationVariantMappingVersions).set({
          externalInventoryItemId: command.externalInventoryItemId,
          externalSku: command.externalSku,
          definitionHash,
          changeReason: command.changeReason,
          updatedAt: command.occurredAt,
        }).where(eq(publicationVariantMappingVersions.id, definitionId));
      } else {
        const predecessorId = head?.active_mapping_id == null
          ? null
          : positiveInteger(head.active_mapping_id, "variantMappingHead.activeMappingId");
        const versionRows = rows(await tx.execute(sql`
          SELECT COALESCE(max(version), 0) + 1 AS next_version
          FROM inventory.publication_variant_mapping_versions
          WHERE publication_target_id = ${command.publicationTargetId}
            AND product_variant_id = ${command.productVariantId}
        `));
        version = positiveInteger(versionRows[0]?.next_version, "variantMapping.nextVersion");
        const inserted = await tx.insert(publicationVariantMappingVersions).values({
          publicationTargetId: command.publicationTargetId,
          productVariantId: command.productVariantId,
          version,
          lifecycleStatus: "draft",
          externalInventoryItemId: command.externalInventoryItemId,
          externalSku: command.externalSku,
          definitionHash,
          supersedesMappingId: predecessorId,
          changeReason: command.changeReason,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          createdBy: command.actorId,
          createdAt: command.occurredAt,
          updatedAt: command.occurredAt,
        }).returning({ id: publicationVariantMappingVersions.id });
        definitionId = inserted[0]!.id;
        if (head) {
          await tx.update(publicationVariantMappingHeads).set({
            draftMappingId: definitionId,
            revision: sql`${publicationVariantMappingHeads.revision} + 1`,
            updatedBy: command.actorId,
            updateReason: command.changeReason,
            updatedAt: command.occurredAt,
          }).where(sql`${publicationVariantMappingHeads.publicationTargetId} = ${command.publicationTargetId}
            AND ${publicationVariantMappingHeads.productVariantId} = ${command.productVariantId}`);
        } else {
          await tx.insert(publicationVariantMappingHeads).values({
            publicationTargetId: command.publicationTargetId,
            productVariantId: command.productVariantId,
            activeMappingId: null,
            draftMappingId: definitionId,
            revision: BigInt(1),
            updatedBy: command.actorId,
            updateReason: command.changeReason,
            updatedAt: command.occurredAt,
          });
        }
      }
      if (head?.draft_mapping_id != null) {
        await tx.update(publicationVariantMappingHeads).set({
          revision: sql`${publicationVariantMappingHeads.revision} + 1`,
          updatedBy: command.actorId,
          updateReason: command.changeReason,
          updatedAt: command.occurredAt,
        }).where(sql`${publicationVariantMappingHeads.publicationTargetId} = ${command.publicationTargetId}
          AND ${publicationVariantMappingHeads.productVariantId} = ${command.productVariantId}`);
      }
      const result = channelExposureDraftSaveResultSchema.parse({
        definitionId,
        version,
        definitionHash,
        headRevision: (BigInt(command.expectedHeadRevision) + BigInt(1)).toString(),
        alreadyApplied: false,
        runtimeAuthorityChanged: false,
        providerWriteAttempted: false,
      });
      await persistAuditEvent(tx, {
        actor: command.actorId,
        action: "inventory_availability.publication_variant_mapping.draft_saved",
        target: `inventory.publication_variant_mapping:${definitionId}`,
        changes: { before: null, after: {
          publicationTargetId: command.publicationTargetId,
          productVariantId: command.productVariantId,
          externalInventoryItemId: command.externalInventoryItemId,
          externalSku: command.externalSku,
          definitionHash,
        } },
        context: { idempotencyKey: command.idempotencyKey, requestHash: command.requestHash,
          runtimeAuthorityChanged: false, providerWriteAttempted: false },
      }, { timestamp: command.occurredAt, emitStructuredLog: false });
      await completeReceipt(tx, receiptKey, "publication_variant_mapping_draft_save", result);
      return result;
    });
  }

  async savePolicyDraft(
    command: SaveChannelExposurePolicyDraftCommand,
  ): Promise<ChannelExposureDraftSaveResult> {
    return this.database.transaction(async (tx) => {
      const receiptKey = `${POLICY_RECEIPT_PREFIX}${command.idempotencyKey}`;
      await lockIdempotency(tx, command.idempotencyKey);
      const replay = await loadReplay(tx, receiptKey, command.requestHash);
      if (replay) return replay;
      await insertReceipt(tx, receiptKey, command.requestHash, command.occurredAt);

      const scopeKey = channelExposurePolicyScopeKey(command.scope);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${POLICY_LOCK_NAMESPACE}, hashtext(${scopeKey}))`);
      await validatePolicyScope(tx, command.scope);
      const headRows = rows(await tx.execute(sql`
        SELECT scope_key, revision, active_policy_id, draft_policy_id
        FROM inventory.channel_exposure_policy_heads
        WHERE scope_key = ${scopeKey}
        FOR UPDATE
      `));
      const head = headRows[0] ?? null;
      assertExpectedPolicyHead(head, command);
      const definitionHash = calculateChannelExposureDefinitionHash({
        scope: command.scope,
        value: command.value,
      });
      let definitionId: number;
      let version: number;
      if (head?.draft_policy_id != null) {
        definitionId = positiveInteger(head.draft_policy_id, "policyHead.draftPolicyId");
        const draftRows = rows(await tx.execute(sql`
          SELECT id, version, definition_hash
          FROM inventory.channel_exposure_policy_versions
          WHERE id = ${definitionId}
          FOR UPDATE
        `));
        const draft = draftRows[0];
        if (!draft || String(draft.definition_hash) !== command.expectedDraftDefinitionHash) {
          throw stalePolicy();
        }
        version = positiveInteger(draft.version, "policy.version");
        await tx.update(channelExposurePolicyVersions).set({
          ...policyColumns(command.value),
          definitionHash,
          changeReason: command.changeReason,
          updatedAt: command.occurredAt,
        }).where(eq(channelExposurePolicyVersions.id, definitionId));
      } else {
        const predecessorId = head?.active_policy_id == null
          ? null
          : positiveInteger(head.active_policy_id, "policyHead.activePolicyId");
        const versionRows = rows(await tx.execute(sql`
          SELECT COALESCE(max(version), 0) + 1 AS next_version
          FROM inventory.channel_exposure_policy_versions
          WHERE scope_key = ${scopeKey}
        `));
        version = positiveInteger(versionRows[0]?.next_version, "policy.nextVersion");
        const inserted = await tx.insert(channelExposurePolicyVersions).values({
          scopeKey,
          channelId: command.scope.channelId,
          scopeType: command.scope.scopeType,
          productId: command.scope.scopeType === "channel" ? null : command.scope.productId,
          productVariantId: command.scope.scopeType === "variant" ? command.scope.productVariantId : null,
          version,
          lifecycleStatus: "draft",
          ...policyColumns(command.value),
          definitionHash,
          supersedesPolicyId: predecessorId,
          changeReason: command.changeReason,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          createdBy: command.actorId,
          createdAt: command.occurredAt,
          updatedAt: command.occurredAt,
        }).returning({ id: channelExposurePolicyVersions.id });
        definitionId = inserted[0]!.id;
        if (head) {
          await tx.update(channelExposurePolicyHeads).set({
            draftPolicyId: definitionId,
            revision: sql`${channelExposurePolicyHeads.revision} + 1`,
            updatedBy: command.actorId,
            updateReason: command.changeReason,
            updatedAt: command.occurredAt,
          }).where(eq(channelExposurePolicyHeads.scopeKey, scopeKey));
        } else {
          await tx.insert(channelExposurePolicyHeads).values({
            scopeKey,
            channelId: command.scope.channelId,
            activePolicyId: null,
            draftPolicyId: definitionId,
            revision: BigInt(1),
            updatedBy: command.actorId,
            updateReason: command.changeReason,
            updatedAt: command.occurredAt,
          });
        }
      }
      if (head?.draft_policy_id != null) {
        await tx.update(channelExposurePolicyHeads).set({
          revision: sql`${channelExposurePolicyHeads.revision} + 1`,
          updatedBy: command.actorId,
          updateReason: command.changeReason,
          updatedAt: command.occurredAt,
        }).where(eq(channelExposurePolicyHeads.scopeKey, scopeKey));
      }
      const result = channelExposureDraftSaveResultSchema.parse({
        definitionId,
        version,
        definitionHash,
        headRevision: (BigInt(command.expectedHeadRevision) + BigInt(1)).toString(),
        alreadyApplied: false,
        runtimeAuthorityChanged: false,
        providerWriteAttempted: false,
      });
      await persistAuditEvent(tx, {
        actor: command.actorId,
        action: "inventory_availability.channel_exposure_policy.draft_saved",
        target: `inventory.channel_exposure_policy:${definitionId}`,
        changes: { before: null, after: { scope: command.scope, value: command.value, definitionHash } },
        context: { idempotencyKey: command.idempotencyKey, requestHash: command.requestHash,
          runtimeAuthorityChanged: false, providerWriteAttempted: false },
      }, { timestamp: command.occurredAt, emitStructuredLog: false });
      await completeReceipt(tx, receiptKey, "channel_exposure_policy_draft_save", result);
      return result;
    });
  }

  async saveSourceBindingDraft(
    command: SavePublicationSourceBindingDraftCommand,
  ): Promise<ChannelExposureDraftSaveResult> {
    return this.database.transaction(async (tx) => {
      const receiptKey = `${SOURCE_RECEIPT_PREFIX}${command.idempotencyKey}`;
      await lockIdempotency(tx, command.idempotencyKey);
      const replay = await loadReplay(tx, receiptKey, command.requestHash);
      if (replay) return replay;
      await insertReceipt(tx, receiptKey, command.requestHash, command.occurredAt);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(${SOURCE_BINDING_LOCK_NAMESPACE}, ${command.publicationTargetId})
      `);
      await validateSourceBinding(tx, command.publicationTargetId, command.fulfillmentNodeIds);
      const headRows = rows(await tx.execute(sql`
        SELECT publication_target_id, revision, active_binding_id, draft_binding_id
        FROM inventory.publication_source_binding_heads
        WHERE publication_target_id = ${command.publicationTargetId}
        FOR UPDATE
      `));
      const head = headRows[0] ?? null;
      assertExpectedSourceHead(head, command);
      const definitionHash = calculatePublicationSourceBindingDefinitionHash({
        publicationTargetId: command.publicationTargetId,
        fulfillmentNodeIds: command.fulfillmentNodeIds,
      });
      let definitionId: number;
      let version: number;
      if (head?.draft_binding_id != null) {
        definitionId = positiveInteger(head.draft_binding_id, "sourceHead.draftBindingId");
        const draftRows = rows(await tx.execute(sql`
          SELECT id, version, definition_hash
          FROM inventory.publication_source_binding_versions
          WHERE id = ${definitionId}
          FOR UPDATE
        `));
        const draft = draftRows[0];
        if (!draft || String(draft.definition_hash) !== command.expectedDraftDefinitionHash) {
          throw staleSourceBinding();
        }
        version = positiveInteger(draft.version, "sourceBinding.version");
        await tx.delete(publicationSourceBindingMembers)
          .where(eq(publicationSourceBindingMembers.bindingId, definitionId));
        await tx.update(publicationSourceBindingVersions).set({
          definitionHash,
          changeReason: command.changeReason,
          updatedAt: command.occurredAt,
        }).where(eq(publicationSourceBindingVersions.id, definitionId));
      } else {
        const predecessorId = head?.active_binding_id == null
          ? null
          : positiveInteger(head.active_binding_id, "sourceHead.activeBindingId");
        const versionRows = rows(await tx.execute(sql`
          SELECT COALESCE(max(version), 0) + 1 AS next_version
          FROM inventory.publication_source_binding_versions
          WHERE publication_target_id = ${command.publicationTargetId}
        `));
        version = positiveInteger(versionRows[0]?.next_version, "sourceBinding.nextVersion");
        const inserted = await tx.insert(publicationSourceBindingVersions).values({
          publicationTargetId: command.publicationTargetId,
          version,
          lifecycleStatus: "draft",
          definitionHash,
          supersedesBindingId: predecessorId,
          changeReason: command.changeReason,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          createdBy: command.actorId,
          createdAt: command.occurredAt,
          updatedAt: command.occurredAt,
        }).returning({ id: publicationSourceBindingVersions.id });
        definitionId = inserted[0]!.id;
        if (head) {
          await tx.update(publicationSourceBindingHeads).set({
            draftBindingId: definitionId,
            revision: sql`${publicationSourceBindingHeads.revision} + 1`,
            updatedBy: command.actorId,
            updateReason: command.changeReason,
            updatedAt: command.occurredAt,
          }).where(eq(publicationSourceBindingHeads.publicationTargetId, command.publicationTargetId));
        } else {
          await tx.insert(publicationSourceBindingHeads).values({
            publicationTargetId: command.publicationTargetId,
            activeBindingId: null,
            draftBindingId: definitionId,
            revision: BigInt(1),
            updatedBy: command.actorId,
            updateReason: command.changeReason,
            updatedAt: command.occurredAt,
          });
        }
      }
      await tx.insert(publicationSourceBindingMembers).values(
        command.fulfillmentNodeIds.map((fulfillmentNodeId, index) => ({
          bindingId: definitionId,
          publicationTargetId: command.publicationTargetId,
          fulfillmentNodeId,
          priority: index + 1,
          createdAt: command.occurredAt,
        })),
      );
      if (head?.draft_binding_id != null) {
        await tx.update(publicationSourceBindingHeads).set({
          revision: sql`${publicationSourceBindingHeads.revision} + 1`,
          updatedBy: command.actorId,
          updateReason: command.changeReason,
          updatedAt: command.occurredAt,
        }).where(eq(publicationSourceBindingHeads.publicationTargetId, command.publicationTargetId));
      }
      const result = channelExposureDraftSaveResultSchema.parse({
        definitionId,
        version,
        definitionHash,
        headRevision: (BigInt(command.expectedHeadRevision) + BigInt(1)).toString(),
        alreadyApplied: false,
        runtimeAuthorityChanged: false,
        providerWriteAttempted: false,
      });
      await persistAuditEvent(tx, {
        actor: command.actorId,
        action: "inventory_availability.publication_source_binding.draft_saved",
        target: `inventory.publication_source_binding:${definitionId}`,
        changes: { before: null, after: { publicationTargetId: command.publicationTargetId,
          fulfillmentNodeIds: command.fulfillmentNodeIds, definitionHash } },
        context: { idempotencyKey: command.idempotencyKey, requestHash: command.requestHash,
          runtimeAuthorityChanged: false, providerWriteAttempted: false },
      }, { timestamp: command.occurredAt, emitStructuredLog: false });
      await completeReceipt(tx, receiptKey, "publication_source_binding_draft_save", result);
      return result;
    });
  }

  async preview(publicationTargetId: number, productId: number): Promise<InventoryChannelExposurePreview> {
    const run = await this.shadowStore.getLatestShadowRun(productId);
    if (!run) {
      throw new InventoryAvailabilityMasterDataError(
        404,
        "INVENTORY_CHANNEL_EXPOSURE_SHADOW_NOT_FOUND",
        "Run the canonical ATP shadow for this product before previewing channel exposure.",
      );
    }
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const targetRows = rows(await tx.execute(sql`
        SELECT id, destination_kind, channel_id, channel_connection_id,
               dropship_store_connection_id, provider_scope_type,
               external_scope_id, publication_authority, state, revision
        FROM inventory.inventory_publication_targets
        WHERE id = ${publicationTargetId}
      `));
      const target = targetRows[0];
      if (!target) {
        throw new InventoryAvailabilityMasterDataError(
          404,
          "INVENTORY_CHANNEL_EXPOSURE_TARGET_NOT_FOUND",
          "The selected publication target was not found.",
        );
      }
      const channelId = positiveInteger(target.channel_id, "target.channelId");
      const channelConnectionId = nullablePositiveInteger(
        target.channel_connection_id,
        "target.channelConnectionId",
      );
      const dropshipStoreConnectionId = nullablePositiveInteger(
        target.dropship_store_connection_id,
        "target.dropshipStoreConnectionId",
      );
      const sellableVariantRows = rows(await tx.execute(sql`
        SELECT id
        FROM catalog.product_variants
        WHERE product_id = ${productId}
          AND is_active = true
          AND requires_shipping = true
          AND COALESCE(track_inventory, true) = true
          AND sales_eligibility = 'sellable'
        ORDER BY id
      `));
      const sellableVariantIds = new Set(sellableVariantRows.map((row) =>
        positiveInteger(row.id, "variant.id")));
      const bindingRows = rows(await tx.execute(sql`
        SELECT head.draft_binding_id, head.active_binding_id,
               COALESCE(head.draft_binding_id, head.active_binding_id) AS selected_binding_id,
               selected_binding.version AS selected_binding_version,
               selected_binding.definition_hash AS selected_binding_definition_hash,
               member.fulfillment_node_id, node.warehouse_id
        FROM inventory.publication_source_binding_heads AS head
        LEFT JOIN inventory.publication_source_binding_versions AS selected_binding
          ON selected_binding.id = COALESCE(head.draft_binding_id, head.active_binding_id)
        LEFT JOIN inventory.publication_source_binding_members AS member
          ON member.binding_id = COALESCE(head.draft_binding_id, head.active_binding_id)
        LEFT JOIN warehouse.fulfillment_nodes AS node ON node.id = member.fulfillment_node_id
        WHERE head.publication_target_id = ${publicationTargetId}
        ORDER BY member.priority
      `));
      const binding = bindingRows[0] ?? null;
      const sourceBindingId = binding?.selected_binding_id == null
        ? null
        : positiveInteger(binding.selected_binding_id, "sourceBinding.id");
      const sourceBindingVersion = binding?.selected_binding_version == null
        ? null
        : positiveInteger(binding.selected_binding_version, "sourceBinding.version");
      const sourceBindingDefinitionHash = binding?.selected_binding_definition_hash == null
        ? null
        : String(binding.selected_binding_definition_hash);
      const sourceBindingAuthority = sourceBindingId === null
        ? "missing" as const
        : binding.draft_binding_id != null ? "draft" as const : "active" as const;
      const fulfillmentNodeIds = bindingRows.flatMap((row) => row.fulfillment_node_id == null
        ? [] : [positiveInteger(row.fulfillment_node_id, "sourceBinding.nodeId")]);
      const warehouseIds = [...new Set(bindingRows.flatMap((row) => row.warehouse_id == null
        ? [] : [positiveInteger(row.warehouse_id, "sourceBinding.warehouseId")]))].sort((a, b) => a - b);
      const policyRows = rows(await tx.execute(sql`
        SELECT head.scope_key, pointer.pointer_type, policy.id AS policy_id,
               policy.version, policy.definition_hash, policy.scope_type,
               policy.allocation_semantics, policy.eligible, policy.share_bps,
               policy.holdback_sellable_units, policy.max_publish_mode,
               policy.max_publish_sellable_units, policy.min_publish_sellable_units
        FROM inventory.channel_exposure_policy_heads AS head
        CROSS JOIN LATERAL (
          VALUES ('draft', head.draft_policy_id), ('active', head.active_policy_id)
        ) AS pointer(pointer_type, policy_id)
        JOIN inventory.channel_exposure_policy_versions AS policy ON policy.id = pointer.policy_id
        WHERE head.channel_id = ${channelId}
          AND (policy.scope_type = 'channel' OR policy.product_id = ${productId})
        ORDER BY head.scope_key, CASE pointer.pointer_type WHEN 'draft' THEN 0 ELSE 1 END
      `));
      const policyCandidates = selectedPolicyCandidates(policyRows);
      const selectedPolicies = selectedPolicyEvidence(policyRows);
      const variantMappingRows = rows(await tx.execute(sql`
        SELECT head.product_variant_id, pointer.pointer_type,
               mapping.id AS mapping_id, mapping.version, mapping.definition_hash,
               mapping.external_inventory_item_id, mapping.external_sku
        FROM inventory.publication_variant_mapping_heads AS head
        CROSS JOIN LATERAL (
          VALUES ('draft', head.draft_mapping_id), ('active', head.active_mapping_id)
        ) AS pointer(pointer_type, mapping_id)
        JOIN inventory.publication_variant_mapping_versions AS mapping ON mapping.id = pointer.mapping_id
        WHERE head.publication_target_id = ${publicationTargetId}
          AND head.product_variant_id = ANY(${sqlIntegerArray([...sellableVariantIds])})
        ORDER BY head.product_variant_id,
                 CASE pointer.pointer_type WHEN 'draft' THEN 0 ELSE 1 END
      `));
      const selectedMappings = selectedVariantMappingEvidence(variantMappingRows);
      const selectedModelRows = rows(await tx.execute(sql`
        SELECT model.id AS model_id, model.version, model.definition_hash
        FROM inventory.transformation_model_heads AS head
        JOIN inventory.transformation_model_versions AS model
          ON model.id = COALESCE(head.draft_model_id, head.active_model_id)
        WHERE head.product_id = ${productId}
      `));
      const selectedModel = selectedModelRows[0] ?? null;
      const blockers: InventoryChannelExposurePreview["blockers"] = run.blockerCodes.map((code) => ({
        code,
        message: "The canonical ATP shadow contains a configuration blocker.",
        context: { shadowRunId: run.runId },
      }));
      if (String(target.state) === "disabled") {
        blockers.push({
          code: "PUBLICATION_TARGET_NOT_IN_PREVIEW",
          message: "This exact publication target is disabled and cannot enter activation readiness review.",
          context: { publicationTargetId },
        });
      }
      if (run.status !== "completed") {
        blockers.push({
          code: "CANONICAL_SHADOW_BLOCKED",
          message: "The latest canonical ATP shadow did not complete successfully.",
          context: { shadowRunId: run.runId },
        });
      }
      const selectedModelEvidence = selectedModel ? {
        modelId: positiveInteger(selectedModel.model_id, "selectedModel.id"),
        modelVersion: positiveInteger(selectedModel.version, "selectedModel.version"),
        modelDefinitionHash: String(selectedModel.definition_hash),
      } : { modelId: null, modelVersion: null, modelDefinitionHash: null };
      if (selectedModelEvidence.modelId !== run.modelId
        || selectedModelEvidence.modelVersion !== run.modelVersion
        || selectedModelEvidence.modelDefinitionHash !== run.modelDefinitionHash) {
        blockers.push({
          code: "SHADOW_MODEL_STALE",
          message: "The selected transformation model differs from the model captured by this ATP shadow.",
          context: { shadowRunId: run.runId, selectedModel: selectedModelEvidence,
            shadowModel: { modelId: run.modelId, modelVersion: run.modelVersion,
              modelDefinitionHash: run.modelDefinitionHash } },
        });
      }
      if (sourceBindingId === null || warehouseIds.length === 0) {
        blockers.push({
          code: "CHANNEL_SOURCE_BINDING_MISSING",
          message: "This publication target has no explicit draft or active fulfillment-node scope.",
          context: { publicationTargetId },
        });
      }
      const shadowWarehouseIds = new Set(run.results.flatMap((result) =>
        result.warehouseId === null ? [] : [result.warehouseId]));
      const missingWarehouseIds = warehouseIds.filter((warehouseId) => !shadowWarehouseIds.has(warehouseId));
      if (missingWarehouseIds.length > 0) {
        blockers.push({
          code: "CHANNEL_SOURCE_WAREHOUSE_MISSING_FROM_SHADOW",
          message: "A selected fulfillment node maps to a warehouse absent from the sealed ATP shadow.",
          context: { publicationTargetId, warehouseIds: missingWarehouseIds },
        });
      }
      const rowsByVariant = new Map<number, typeof run.results>();
      for (const result of run.results) {
        if (!sellableVariantIds.has(result.productVariantId)) continue;
        const values = rowsByVariant.get(result.productVariantId) ?? [];
        values.push(result);
        rowsByVariant.set(result.productVariantId, values);
      }
      for (const productVariantId of sellableVariantIds) {
        const variantResults = rowsByVariant.get(productVariantId);
        if (!variantResults || !variantResults.some((row) => row.warehouseId === null)) {
          blockers.push({
            code: "CHANNEL_EXPOSURE_SKU_MISSING_FROM_SHADOW",
            message: "An active sellable SKU has no network row in the sealed canonical ATP shadow.",
            context: { publicationTargetId, productId, productVariantId },
          });
        }
      }
      const previewRows = [...rowsByVariant.entries()].sort(([left], [right]) => left - right)
        .flatMap(([productVariantId, results]): InventoryChannelExposurePreview["rows"] => {
          const network = results.find((row) => row.warehouseId === null);
          if (!network) return [];
          const resolution = resolveChannelExposurePolicy({
            channelId,
            productId,
            productVariantId,
            policies: policyCandidates,
          });
          const mapping = selectedMappings.get(productVariantId) ?? null;
          const sourceWarehouseBreakdown = sourceBindingId === null ? [] : results
            .filter((row) => row.warehouseId !== null && warehouseIds.includes(row.warehouseId))
            .map((row) => ({
              warehouseId: row.warehouseId!,
              canonicalAtpUnits: BigInt(row.proposedAtpUnits).toString(),
            }))
            .sort((left, right) => left.warehouseId - right.warehouseId);
          const canonicalAtp = sourceWarehouseBreakdown.reduce(
            (total, row) => total + BigInt(row.canonicalAtpUnits),
            BigInt(0),
          );
          if (!resolution.policy) {
            blockers.push({
              code: "CHANNEL_EXPOSURE_POLICY_INCOMPLETE",
              message: "Required channel-exposure fields do not resolve through SKU, product, and channel scopes.",
              context: { publicationTargetId, channelId, productId, productVariantId,
                missingFields: resolution.missingFields },
            });
            return [{
              productVariantId,
              sku: network.productVariantSkuSnapshot,
              unitsPerVariant: network.productVariantUnitsPerVariantSnapshot,
              canonicalAtpUnits: canonicalAtp.toString(),
              sharedUnits: "0",
              afterHoldbackUnits: "0",
              cappedUnits: "0",
              publishedUnits: "0",
              sourceWarehouseBreakdown,
              policy: null,
              mapping,
            }];
          }
          if (resolution.policy.eligible && mapping === null) {
            blockers.push({
              code: "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING",
              message: "An eligible SKU has no exact provider inventory identity for this publication target.",
              context: { publicationTargetId, channelId, productId, productVariantId },
            });
          }
          const calculation = calculateChannelExposure(canonicalAtp, resolution.policy);
          return [{
            productVariantId,
            sku: network.productVariantSkuSnapshot,
            unitsPerVariant: network.productVariantUnitsPerVariantSnapshot,
            canonicalAtpUnits: calculation.canonicalAtpUnits.toString(),
            sharedUnits: calculation.sharedUnits.toString(),
            afterHoldbackUnits: calculation.afterHoldbackUnits.toString(),
            cappedUnits: calculation.cappedUnits.toString(),
            publishedUnits: calculation.publishedUnits.toString(),
            sourceWarehouseBreakdown,
            policy: resolution.policy,
            mapping,
          }];
        });
      return inventoryChannelExposurePreviewSchema.parse({
        publicationTargetId,
        destinationKind: String(target.destination_kind),
        channelId,
        channelConnectionId,
        dropshipStoreConnectionId,
        providerScopeType: String(target.provider_scope_type),
        externalScopeId: String(target.external_scope_id),
        publicationAuthority: String(target.publication_authority),
        publicationTargetState: String(target.state),
        publicationTargetRevision: String(target.revision),
        productId,
        shadowRunId: run.runId,
        snapshotFingerprint: run.snapshotFingerprint,
        shadowCapturedAt: run.capturedAt,
        modelId: run.modelId,
        modelVersion: run.modelVersion,
        modelDefinitionHash: run.modelDefinitionHash,
        sourceBindingId,
        sourceBindingVersion,
        sourceBindingDefinitionHash,
        sourceBindingAuthority,
        fulfillmentNodeIds,
        warehouseIds,
        selectedPolicies,
        rows: previewRows,
        blockers: uniqueBlockers(blockers),
        runtimeAuthorityChanged: false,
        providerWriteAttempted: false,
        outboxEnqueued: false,
      });
    });
  }
}

function policyColumns(value: ChannelExposurePolicyValue) {
  return {
    allocationSemantics: value.allocationSemantics,
    eligible: value.eligible,
    shareBps: value.shareBps,
    holdbackSellableUnits: value.holdbackSellableUnits === null
      ? null : BigInt(value.holdbackSellableUnits),
    maxPublishMode: value.maxPublish?.mode ?? null,
    maxPublishSellableUnits: value.maxPublish?.mode === "units"
      ? BigInt(value.maxPublish.units) : null,
    minPublishSellableUnits: value.minPublishSellableUnits === null
      ? null : BigInt(value.minPublishSellableUnits),
  };
}

async function validatePublicationTarget(
  tx: Transaction,
  command: CreateInventoryPublicationTargetCommand,
): Promise<void> {
  const found = rows(await tx.execute(command.destinationKind === "channel_connection"
    ? sql`
        SELECT connection.id AS destination_id, node.id AS node_id
        FROM channels.channel_connections AS connection
        JOIN warehouse.fulfillment_nodes AS node
          ON node.id = ${command.legacyFulfillmentNodeId}
         AND node.lifecycle_status <> 'retired'
        WHERE connection.id = ${command.channelConnectionId}
          AND connection.channel_id = ${command.channelId}
      `
    : sql`
        SELECT connection.id AS destination_id, node.id AS node_id
        FROM dropship.dropship_store_connections AS connection
        JOIN channels.channels AS policy_channel ON policy_channel.id = ${command.channelId}
        JOIN warehouse.fulfillment_nodes AS node
          ON node.id = ${command.legacyFulfillmentNodeId}
         AND node.lifecycle_status <> 'retired'
        WHERE connection.id = ${command.dropshipStoreConnectionId}
      `));
  if (found.length === 0) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_PUBLICATION_TARGET_SCOPE_INVALID",
      command.destinationKind === "channel_connection"
        ? "The channel connection and compatibility fulfillment node must exist and match the target scope."
        : "The allocation-policy channel, Dropship store connection, and compatibility fulfillment node must exist.",
    );
  }
}

async function validateVariantMapping(
  tx: Transaction,
  publicationTargetId: number,
  productVariantId: number,
): Promise<void> {
  const found = rows(await tx.execute(sql`
    SELECT target.id AS target_id, variant.id AS variant_id
    FROM inventory.inventory_publication_targets AS target
    JOIN catalog.product_variants AS variant
      ON variant.id = ${productVariantId}
     AND variant.is_active = true
     AND variant.requires_shipping = true
     AND COALESCE(variant.track_inventory, true) = true
     AND variant.sales_eligibility = 'sellable'
    JOIN catalog.products AS product
      ON product.id = variant.product_id
     AND product.is_active = true
    WHERE target.id = ${publicationTargetId}
  `));
  if (found.length === 0) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_PUBLICATION_VARIANT_MAPPING_SCOPE_INVALID",
      "The target must exist and the mapped SKU must be active, physical, tracked, and customer-sellable.",
    );
  }
}

async function validatePolicyScope(tx: Transaction, scope: ChannelExposurePolicyScope): Promise<void> {
  const rowsFound = rows(await tx.execute(sql`
    SELECT channel.id AS channel_id, product.id AS product_id, product.is_active AS product_is_active,
           variant.id AS variant_id, variant.is_active AS variant_is_active,
           variant.sales_eligibility, variant.requires_shipping,
           COALESCE(variant.track_inventory, true) AS track_inventory
    FROM channels.channels AS channel
    LEFT JOIN catalog.products AS product ON product.id = ${scope.scopeType === "channel" ? null : scope.productId}
    LEFT JOIN catalog.product_variants AS variant
      ON variant.id = ${scope.scopeType === "variant" ? scope.productVariantId : null}
     AND variant.product_id = product.id
    WHERE channel.id = ${scope.channelId}
  `));
  const row = rowsFound[0];
  if (!row || (scope.scopeType !== "channel" && row.product_id == null)
    || (scope.scopeType === "variant" && row.variant_id == null)) {
    throw new InventoryAvailabilityMasterDataError(
      404,
      "INVENTORY_CHANNEL_EXPOSURE_SCOPE_NOT_FOUND",
      "The selected channel, product, or SKU scope does not exist.",
    );
  }
  if (scope.scopeType !== "channel" && !Boolean(row.product_is_active)) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_CHANNEL_EXPOSURE_PRODUCT_INACTIVE",
      "Only an active product can receive channel exposure.",
    );
  }
  if (scope.scopeType === "variant" && (
    !Boolean(row.variant_is_active)
    ||
    String(row.sales_eligibility) !== "sellable"
    || !Boolean(row.requires_shipping)
    || !Boolean(row.track_inventory)
  )) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_CHANNEL_EXPOSURE_VARIANT_NOT_SELLABLE",
      "Only a physical, inventory-tracked, customer-sellable SKU can receive channel exposure.",
    );
  }
}

async function validateSourceBinding(
  tx: Transaction,
  publicationTargetId: number,
  fulfillmentNodeIds: number[],
): Promise<void> {
  const targetRows = rows(await tx.execute(sql`
    SELECT id FROM inventory.inventory_publication_targets WHERE id = ${publicationTargetId}
  `));
  if (targetRows.length === 0) {
    throw new InventoryAvailabilityMasterDataError(
      404,
      "INVENTORY_CHANNEL_EXPOSURE_TARGET_NOT_FOUND",
      "The selected publication target does not exist.",
    );
  }
  const nodeRows = rows(await tx.execute(sql`
    SELECT id FROM warehouse.fulfillment_nodes
    WHERE id = ANY(${sqlIntegerArray(fulfillmentNodeIds)})
      AND lifecycle_status <> 'retired'
  `));
  if (nodeRows.length !== fulfillmentNodeIds.length) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_CHANNEL_EXPOSURE_SOURCE_NODE_INVALID",
      "Every source node must exist and must not be retired.",
    );
  }
}

function assertExpectedPolicyHead(
  head: Record<string, any> | null,
  command: SaveChannelExposurePolicyDraftCommand,
): void {
  const revision = head ? String(head.revision) : "0";
  const draftId = head?.draft_policy_id == null ? null : Number(head.draft_policy_id);
  if (revision !== command.expectedHeadRevision || draftId !== command.expectedDraftPolicyId) {
    throw stalePolicy();
  }
}

function assertExpectedSourceHead(
  head: Record<string, any> | null,
  command: SavePublicationSourceBindingDraftCommand,
): void {
  const revision = head ? String(head.revision) : "0";
  const draftId = head?.draft_binding_id == null ? null : Number(head.draft_binding_id);
  if (revision !== command.expectedHeadRevision || draftId !== command.expectedDraftBindingId) {
    throw staleSourceBinding();
  }
}

function assertExpectedVariantMappingHead(
  head: Record<string, any> | null,
  command: SavePublicationVariantMappingDraftCommand,
): void {
  const revision = head ? String(head.revision) : "0";
  const draftId = head?.draft_mapping_id == null ? null : Number(head.draft_mapping_id);
  if (revision !== command.expectedHeadRevision || draftId !== command.expectedDraftMappingId) {
    throw staleVariantMapping();
  }
}

function stalePolicy(): InventoryAvailabilityMasterDataError {
  return new InventoryAvailabilityMasterDataError(
    409,
    "INVENTORY_CHANNEL_EXPOSURE_STALE_POLICY_DRAFT",
    "The channel-exposure policy draft changed. Reload it before saving.",
  );
}

function staleSourceBinding(): InventoryAvailabilityMasterDataError {
  return new InventoryAvailabilityMasterDataError(
    409,
    "INVENTORY_CHANNEL_EXPOSURE_STALE_SOURCE_BINDING",
    "The publication source binding changed. Reload it before saving.",
  );
}

function staleVariantMapping(): InventoryAvailabilityMasterDataError {
  return new InventoryAvailabilityMasterDataError(
    409,
    "INVENTORY_CHANNEL_EXPOSURE_STALE_VARIANT_MAPPING",
    "The exact target/SKU mapping draft changed. Reload it before saving.",
  );
}

async function lockIdempotency(tx: Transaction, key: string): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(${IDEMPOTENCY_LOCK_NAMESPACE}, hashtext(${key}))
  `);
}

async function loadReplay(
  tx: Transaction,
  receiptKey: string,
  requestHash: string,
): Promise<ChannelExposureDraftSaveResult | null> {
  const [receipt] = await tx.select({
    requestHash: idempotencyKeys.requestHash,
    responseBody: idempotencyKeys.responseBody,
  }).from(idempotencyKeys).where(eq(idempotencyKeys.key, receiptKey)).limit(1);
  if (!receipt) return null;
  if (receipt.requestHash !== requestHash) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_CHANNEL_EXPOSURE_IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used with different inputs.",
    );
  }
  const body = receipt.responseBody as Record<string, unknown> | null;
  const parsed = channelExposureDraftSaveResultSchema.safeParse(body?.result);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "INVENTORY_CHANNEL_EXPOSURE_IDEMPOTENCY_RECEIPT_INVALID",
      "The prior channel-exposure command has an incomplete receipt.",
    );
  }
  return { ...parsed.data, alreadyApplied: true };
}

async function loadTargetReplay(
  tx: Transaction,
  receiptKey: string,
  requestHash: string,
): Promise<InventoryPublicationTargetCommandResult | null> {
  const [receipt] = await tx.select({
    requestHash: idempotencyKeys.requestHash,
    responseBody: idempotencyKeys.responseBody,
  }).from(idempotencyKeys).where(eq(idempotencyKeys.key, receiptKey)).limit(1);
  if (!receipt) return null;
  if (receipt.requestHash !== requestHash) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_CHANNEL_EXPOSURE_IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used with different inputs.",
    );
  }
  const body = receipt.responseBody as Record<string, unknown> | null;
  const parsed = inventoryPublicationTargetCommandResultSchema.safeParse(body?.result);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "INVENTORY_PUBLICATION_TARGET_IDEMPOTENCY_RECEIPT_INVALID",
      "The prior publication-target command has an incomplete receipt.",
    );
  }
  return { ...parsed.data, alreadyApplied: true };
}

async function insertReceipt(
  tx: Transaction,
  key: string,
  requestHash: string,
  occurredAt: Date,
): Promise<void> {
  await tx.insert(idempotencyKeys).values({
    key,
    requestHash,
    responseBody: null,
    createdAt: occurredAt,
    expiresAt: null,
  });
}

async function completeReceipt(
  tx: Transaction,
  key: string,
  commandType: string,
  result: ChannelExposureDraftSaveResult,
): Promise<void> {
  await tx.update(idempotencyKeys).set({ responseBody: { commandType, result } })
    .where(eq(idempotencyKeys.key, key));
}

async function completeTargetReceipt(
  tx: Transaction,
  key: string,
  commandType: string,
  result: InventoryPublicationTargetCommandResult,
): Promise<void> {
  await tx.update(idempotencyKeys).set({ responseBody: { commandType, result } })
    .where(eq(idempotencyKeys.key, key));
}

function mapPolicyHeads(policyRows: Record<string, any>[]): ChannelExposurePolicyHead[] {
  const heads = new Map<string, ChannelExposurePolicyHead>();
  for (const row of policyRows) {
    const scopeKey = String(row.scope_key);
    const current = heads.get(scopeKey) ?? {
      scopeKey,
      channelId: positiveInteger(row.channel_id, "policyHead.channelId"),
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

function mapPolicy(row: Record<string, any>): ChannelExposurePolicyVersion {
  const scope = policyScope(row);
  return {
    policyId: positiveInteger(row.policy_id, "policy.id"),
    version: positiveInteger(row.version, "policy.version"),
    lifecycleStatus: String(row.lifecycle_status) as ChannelExposurePolicyVersion["lifecycleStatus"],
    scope,
    value: policyValue(row),
    definitionHash: String(row.definition_hash),
    changeReason: String(row.change_reason),
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at, "policy.createdAt"),
    updatedAt: iso(row.updated_at, "policy.updatedAt"),
  };
}

function policyScope(row: Record<string, any>): ChannelExposurePolicyScope {
  const channelId = positiveInteger(row.channel_id, "policy.channelId");
  if (row.scope_type === "channel") return { scopeType: "channel", channelId };
  const productId = positiveInteger(row.product_id, "policy.productId");
  if (row.scope_type === "product") return { scopeType: "product", channelId, productId };
  return { scopeType: "variant", channelId, productId,
    productVariantId: positiveInteger(row.product_variant_id, "policy.variantId") };
}

function policyValue(row: Record<string, any>): ChannelExposurePolicyValue {
  return {
    allocationSemantics: row.allocation_semantics == null ? null : String(row.allocation_semantics) as "exposure" | "partitioned",
    eligible: row.eligible == null ? null : Boolean(row.eligible),
    shareBps: row.share_bps == null ? null : nonnegativeInteger(row.share_bps, "policy.shareBps"),
    holdbackSellableUnits: nullableQuantity(row.holdback_sellable_units),
    maxPublish: row.max_publish_mode == null ? null
      : row.max_publish_mode === "unlimited" ? { mode: "unlimited" }
        : { mode: "units", units: nonnegativeQuantity(row.max_publish_sellable_units, "policy.maxPublish") },
    minPublishSellableUnits: nullableQuantity(row.min_publish_sellable_units),
  };
}

function mapBindingHeads(bindingRows: Record<string, any>[]): PublicationSourceBindingHead[] {
  const heads = new Map<number, PublicationSourceBindingHead>();
  const versions = new Map<string, PublicationSourceBindingVersion>();
  for (const row of bindingRows) {
    const targetId = positiveInteger(row.publication_target_id, "sourceHead.targetId");
    const pointerType = String(row.pointer_type) as "active" | "draft";
    const key = `${targetId}:${pointerType}`;
    let binding = versions.get(key);
    if (!binding) {
      binding = {
        bindingId: positiveInteger(row.binding_id, "sourceBinding.id"),
        publicationTargetId: targetId,
        version: positiveInteger(row.version, "sourceBinding.version"),
        lifecycleStatus: String(row.lifecycle_status) as PublicationSourceBindingVersion["lifecycleStatus"],
        definitionHash: String(row.definition_hash),
        fulfillmentNodeIds: [],
        changeReason: String(row.change_reason),
        createdBy: String(row.created_by),
        createdAt: iso(row.created_at, "sourceBinding.createdAt"),
        updatedAt: iso(row.updated_at, "sourceBinding.updatedAt"),
      };
      versions.set(key, binding);
    }
    if (row.fulfillment_node_id != null) {
      binding.fulfillmentNodeIds.push(positiveInteger(row.fulfillment_node_id, "sourceBinding.nodeId"));
    }
    const head = heads.get(targetId) ?? {
      publicationTargetId: targetId,
      revision: String(row.revision),
      activeBinding: null,
      draftBinding: null,
    };
    if (pointerType === "active") head.activeBinding = binding;
    if (pointerType === "draft") head.draftBinding = binding;
    heads.set(targetId, head);
  }
  return [...heads.values()].sort((left, right) => left.publicationTargetId - right.publicationTargetId);
}

function mapVariantMappingHeads(mappingRows: Record<string, any>[]): PublicationVariantMappingHead[] {
  const heads = new Map<string, PublicationVariantMappingHead>();
  for (const row of mappingRows) {
    const publicationTargetId = positiveInteger(row.publication_target_id, "variantMapping.targetId");
    const productVariantId = positiveInteger(row.product_variant_id, "variantMapping.variantId");
    const key = `${publicationTargetId}:${productVariantId}`;
    const head = heads.get(key) ?? {
      publicationTargetId,
      productVariantId,
      revision: String(row.revision),
      activeMapping: null,
      draftMapping: null,
    };
    const mapping = mapVariantMapping(row);
    if (String(row.pointer_type) === "active") head.activeMapping = mapping;
    if (String(row.pointer_type) === "draft") head.draftMapping = mapping;
    heads.set(key, head);
  }
  return [...heads.values()].sort((left, right) =>
    left.publicationTargetId - right.publicationTargetId
    || left.productVariantId - right.productVariantId);
}

function mapVariantMapping(row: Record<string, any>): PublicationVariantMappingVersion {
  return {
    mappingId: positiveInteger(row.mapping_id, "variantMapping.id"),
    publicationTargetId: positiveInteger(row.publication_target_id, "variantMapping.targetId"),
    productVariantId: positiveInteger(row.product_variant_id, "variantMapping.variantId"),
    version: positiveInteger(row.version, "variantMapping.version"),
    lifecycleStatus: String(row.lifecycle_status) as PublicationVariantMappingVersion["lifecycleStatus"],
    externalInventoryItemId: String(row.external_inventory_item_id),
    externalSku: nullableText(row.external_sku),
    definitionHash: String(row.definition_hash),
    changeReason: String(row.change_reason),
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at, "variantMapping.createdAt"),
    updatedAt: iso(row.updated_at, "variantMapping.updatedAt"),
  };
}

function selectedVariantMappingEvidence(
  mappingRows: Record<string, any>[],
): Map<number, NonNullable<InventoryChannelExposurePreview["rows"][number]["mapping"]>> {
  const selected = new Map<number, NonNullable<InventoryChannelExposurePreview["rows"][number]["mapping"]>>();
  for (const row of mappingRows) {
    const productVariantId = positiveInteger(row.product_variant_id, "selectedVariantMapping.variantId");
    if (selected.has(productVariantId)) continue;
    selected.set(productVariantId, {
      mappingId: positiveInteger(row.mapping_id, "selectedVariantMapping.id"),
      version: positiveInteger(row.version, "selectedVariantMapping.version"),
      definitionHash: String(row.definition_hash),
      authority: String(row.pointer_type) as "draft" | "active",
      externalInventoryItemId: String(row.external_inventory_item_id),
      externalSku: nullableText(row.external_sku),
    });
  }
  return selected;
}

function selectedPolicyCandidates(rowsInput: Record<string, any>[]): ChannelExposurePolicyCandidate[] {
  return selectedPolicyRows(rowsInput).map((row) => ({
    scopeKey: String(row.scope_key),
    scopeType: String(row.scope_type) as ChannelExposurePolicyCandidate["scopeType"],
    value: policyValue(row),
  }));
}

function selectedPolicyEvidence(
  rowsInput: Record<string, any>[],
): InventoryChannelExposurePreview["selectedPolicies"] {
  return selectedPolicyRows(rowsInput).map((row) => ({
    scopeKey: String(row.scope_key),
    policyId: positiveInteger(row.policy_id, "selectedPolicy.id"),
    version: positiveInteger(row.version, "selectedPolicy.version"),
    definitionHash: String(row.definition_hash),
    authority: String(row.pointer_type) as "draft" | "active",
  }));
}

function selectedPolicyRows(rowsInput: Record<string, any>[]): Record<string, any>[] {
  const selected = new Map<string, Record<string, any>>();
  for (const row of rowsInput) {
    const key = String(row.scope_key);
    if (!selected.has(key)) selected.set(key, row);
  }
  return [...selected.values()].sort((left, right) =>
    String(left.scope_key).localeCompare(String(right.scope_key)));
}

function uniqueBlockers(
  blockers: InventoryChannelExposurePreview["blockers"],
): InventoryChannelExposurePreview["blockers"] {
  return [...new Map(blockers.map((item) => [
    `${item.code}:${JSON.stringify(item.context)}`,
    item,
  ])).values()];
}

function groupBy<T, K>(values: readonly T[], key: (value: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const value of values) result.set(key(value), [...(result.get(key(value)) ?? []), value]);
  return result;
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
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw invalidDatabaseValue(field);
  }
  return parsed;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value == null ? null : positiveInteger(value, field);
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw invalidDatabaseValue(field);
  }
  return parsed;
}

function nonnegativeQuantity(value: unknown, field: string): string {
  try {
    const parsed = BigInt(String(value));
    if (parsed < BigInt(0)) throw new Error("negative");
    return parsed.toString();
  } catch {
    throw invalidDatabaseValue(field);
  }
}

function nullableQuantity(value: unknown): string | null {
  return value == null ? null : nonnegativeQuantity(value, "policy.quantity");
}

function nullableText(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length === 0 ? null : normalized;
}

function iso(value: unknown, field: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw invalidDatabaseValue(field);
  return parsed.toISOString();
}

function invalidDatabaseValue(field: string): InventoryAvailabilityMasterDataError {
  return new InventoryAvailabilityMasterDataError(
    500,
    "INVENTORY_CHANNEL_EXPOSURE_INVALID_DATABASE_VALUE",
    `Inventory channel-exposure ${field} is invalid.`,
  );
}
