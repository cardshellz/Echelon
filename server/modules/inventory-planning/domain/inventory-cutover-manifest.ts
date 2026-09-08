import { createHash } from "node:crypto";
import {
  inventoryCutoverManifestSchema,
  type InventoryCutoverDefinitionSelection,
  type InventoryCutoverManifest,
} from "@shared/types/inventory-cutover-commit";
import { inventoryActivationDryRunSchema, type InventoryActivationDryRun } from "@shared/types/inventory-availability-phase4";
import type { SupplySnapshotDto } from "@shared/types/inventory-availability-planner";
import { canonicalJson } from "@shared/utils/canonical-json";
import { parseSupplySnapshot } from "./inventory-availability-planner";

export class InventoryCutoverManifestError extends Error {
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "InventoryCutoverManifestError";
  }
}

/** Exact reviewed definitions, including non-sellable components reached through a graph. */
export function buildInventoryCutoverManifest(
  input: InventoryActivationDryRun,
  snapshotInputs: readonly SupplySnapshotDto[],
): InventoryCutoverManifest {
  const dryRun = inventoryActivationDryRunSchema.parse(input);
  if (dryRun.state !== "ready_for_publication") {
    throw new InventoryCutoverManifestError("CUTOVER_DRY_RUN_BLOCKED", "Only a ready, reviewed dry run can select definitions.");
  }
  // A matching hash field alone is not evidence: verify the content and graph
  // references before selecting any definition from the persisted snapshot.
  const snapshots = snapshotInputs.map((snapshot) => parseSupplySnapshot(snapshot));
  const snapshotByProduct = new Map(snapshots.map((snapshot) => [snapshot.productId, snapshot]));
  if (snapshotByProduct.size !== snapshots.length || snapshots.length !== dryRun.products.length) {
    throw new InventoryCutoverManifestError("CUTOVER_SNAPSHOT_COVERAGE_INVALID", "Exactly one reviewed snapshot is required for every catalog product.");
  }
  const selections = new Map<string, InventoryCutoverDefinitionSelection>();
  function add(kind: InventoryCutoverDefinitionSelection["kind"], key: string, definitionId: number | null, definitionHash: string | null): void {
    if (definitionId === null || definitionHash === null) {
      throw new InventoryCutoverManifestError("CUTOVER_DEFINITION_MISSING", "The reviewed definition identity is incomplete.", { kind, key });
    }
    const selection = { kind, key, definitionId, definitionHash };
    const mapKey = `${kind}:${key}`;
    const existing = selections.get(mapKey);
    if (existing && (existing.definitionId !== definitionId || existing.definitionHash !== definitionHash)) {
      throw new InventoryCutoverManifestError("CUTOVER_DEFINITION_AMBIGUOUS", "Reviewed products select different definitions for the same head.", { kind, key });
    }
    selections.set(mapKey, selection);
  }
  for (const product of dryRun.products) {
    const snapshot = snapshotByProduct.get(product.productId);
    if (!snapshot || snapshot.snapshotFingerprint !== product.shadowSnapshotFingerprint) {
      throw new InventoryCutoverManifestError("CUTOVER_SNAPSHOT_IDENTITY_CHANGED", "The stored snapshot does not match the reviewed product.", { productId: product.productId });
    }
    add("model", String(product.productId), product.draftModelId, product.draftDefinitionHash);
    const rootModels = snapshot.transformationModels.filter((model) => model.productId === product.productId);
    if (rootModels.length !== 1 || rootModels[0].modelId !== product.draftModelId
      || rootModels[0].definitionHash !== product.draftDefinitionHash
      || rootModels[0].version !== product.draftModelVersion) {
      throw new InventoryCutoverManifestError("CUTOVER_ROOT_MODEL_CHANGED", "The snapshot must contain exactly the reviewed root model.", { productId: product.productId });
    }
    for (const model of snapshot.transformationModels) add("model", String(model.productId), model.modelId, model.definitionHash);
    for (const location of snapshot.locations) {
      if (location.promisePolicy) add("location_policy", String(location.id), location.promisePolicy.policyId, location.promisePolicy.definitionHash);
    }
    for (const safety of snapshot.safetyPolicies) add("safety_policy", safety.scopeKey, safety.policyId, safety.definitionHash);
    for (const publication of product.proposedPublications) {
      if (publication.sourceBindingId !== null || publication.sourceBindingDefinitionHash !== null) {
        add("source_binding", String(publication.publicationTargetId), publication.sourceBindingId, publication.sourceBindingDefinitionHash);
      }
      if (publication.mappingId !== null || publication.mappingDefinitionHash !== null) {
        add("variant_mapping", `${publication.publicationTargetId}:${publication.productVariantId}`, publication.mappingId, publication.mappingDefinitionHash);
      }
      for (const policy of publication.policySelections) add("channel_policy", policy.scopeKey, policy.policyId, policy.definitionHash);
    }
  }
  return inventoryCutoverManifestSchema.parse({
    contractVersion: "inventory_cutover_selection_manifest_v1",
    productIds: dryRun.products.map((product) => product.productId).sort((left, right) => left - right),
    publicationTargetIds: [...new Set(dryRun.products.flatMap((product) => product.proposedPublications.map((row) => row.publicationTargetId)))].sort((left, right) => left - right),
    selections: [...selections.values()].sort((left, right) => {
      const leftKey = `${left.kind}:${left.key}`;
      const rightKey = `${right.kind}:${right.key}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  });
}

export function inventoryCutoverEvidenceHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
