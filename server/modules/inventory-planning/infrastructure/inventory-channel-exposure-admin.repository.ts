import { eq, sql } from "drizzle-orm";

import {
  channelExposurePolicyHeads,
  channelExposurePolicyVersions,
  idempotencyKeys,
  publicationSourceBindingHeads,
  publicationSourceBindingMembers,
  publicationSourceBindingVersions,
} from "@shared/schema";
import {
  channelExposureDraftSaveResultSchema,
  inventoryChannelExposureAdminViewSchema,
  inventoryChannelExposurePreviewSchema,
  type ChannelExposureDraftSaveResult,
  type ChannelExposurePolicyHead,
  type ChannelExposurePolicyScope,
  type ChannelExposurePolicyValue,
  type ChannelExposurePolicyVersion,
  type InventoryChannelExposureAdminView,
  type InventoryChannelExposurePreview,
  type PublicationSourceBindingHead,
  type PublicationSourceBindingVersion,
} from "@shared/types/inventory-channel-exposure";

import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import { sqlIntegerArray } from "../../../infrastructure/postgres-array";
import type {
  InventoryChannelExposureAdminStore,
  SaveChannelExposurePolicyDraftCommand,
  SavePublicationSourceBindingDraftCommand,
} from "../application/inventory-channel-exposure-admin.service";
import {
  calculateChannelExposure,
  calculateChannelExposureDefinitionHash,
  calculatePublicationSourceBindingDefinitionHash,
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
const POLICY_RECEIPT_PREFIX = "inventory-channel-exposure-policy:";
const SOURCE_RECEIPT_PREFIX = "inventory-publication-source-binding:";

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
    const targetRows = rows(await this.database.execute(sql`
      SELECT id, channel_id, channel_connection_id, fulfillment_node_id,
             provider_scope_type, external_scope_id, publication_authority, state
      FROM inventory.inventory_publication_targets
      ORDER BY channel_id, channel_connection_id, external_scope_id, id
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
      publicationTargets: targetRows.map((row) => ({
        id: positiveInteger(row.id, "target.id"),
        channelId: positiveInteger(row.channel_id, "target.channelId"),
        channelConnectionId: positiveInteger(row.channel_connection_id, "target.connectionId"),
        legacyFulfillmentNodeId: positiveInteger(row.fulfillment_node_id, "target.legacyNodeId"),
        providerScopeType: String(row.provider_scope_type),
        externalScopeId: String(row.external_scope_id),
        publicationAuthority: String(row.publication_authority),
        state: String(row.state),
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
      runtimeAuthority: "legacy_channel_allocation_rules",
      providerWriteEnabled: false,
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
        SELECT id, channel_id FROM inventory.inventory_publication_targets
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
          const canonicalAtp = sourceBindingId === null ? BigInt(0) : results
            .filter((row) => row.warehouseId !== null && warehouseIds.includes(row.warehouseId))
            .reduce((total, row) => total + BigInt(row.proposedAtpUnits), BigInt(0));
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
              policy: null,
            }];
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
            policy: resolution.policy,
          }];
        });
      return inventoryChannelExposurePreviewSchema.parse({
        publicationTargetId,
        channelId,
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
  return value == null ? null : String(value);
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
