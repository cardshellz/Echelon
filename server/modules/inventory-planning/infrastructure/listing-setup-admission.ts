import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { ListingSetupIntent } from "../application/listing-setup-intent";
import { QuantityPublicationAdmissionError } from "../domain/quantity-publication-admission";
import {
  resolveChannelExposurePolicy,
  resolveChannelSourceOverride,
} from "../domain/inventory-channel-exposure";
import { captureActiveSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import {
  loadActivePublicationTargets,
  loadManagedSellableVariantIds,
} from "./inventory-channel-exposure-runtime.repository";
import type { ActiveInventoryPublicationTargetSnapshot } from "../application/inventory-channel-exposure-runtime.service";
import { createTransactionScopedInventoryPublicationService } from "./inventory-availability-runtime-publication.repository";
import { validateListingSetupIntent } from "../application/listing-setup-intent";

export type ListingSetupQuantityCache = Map<
  number,
  Awaited<
    ReturnType<
      ReturnType<
        typeof createTransactionScopedInventoryPublicationService
      >["readProductQuantities"]
    >
  >
>;

/** Use the existing quantity planner under the admission transaction. No provider
 * mapping is needed to calculate stock for a SKU which is about to be created. */
export async function resolveListingSetupQuantitiesInsideTransaction(
  client: PoolClient,
  request: Readonly<ListingSetupIntent>,
  cache: ListingSetupQuantityCache = new Map(),
): Promise<Readonly<ListingSetupIntent>> {
  const variants = (
    await client.query<{ id: number; product_id: number }>(
      "SELECT id,product_id FROM catalog.product_variants WHERE id=ANY($1::integer[])",
      [request.items.map((item) => item.productVariantId)],
    )
  ).rows;
  const quantities = new Map<number, number>();
  const publication = createTransactionScopedInventoryPublicationService(
    client,
    { channelId: request.channelId },
  );
  for (const productId of [
    ...new Set(variants.map((row) => row.product_id)),
  ].sort((a, b) => a - b)) {
    const result =
      cache.get(productId) ??
      (await publication.readProductQuantities(
        { productId, dryRun: true, triggeredBy: "walmart_listing_setup" },
        async () =>
          fail(
            "PUBLICATION_SETUP_CANONICAL_REQUIRED",
            "Initial stock requires canonical inventory.",
          ),
      ));
    cache.set(productId, result);
    if (result.authority !== "canonical")
      return fail(
        "PUBLICATION_SETUP_CANONICAL_REQUIRED",
        "Initial stock requires canonical inventory.",
      );
    for (const item of request.items.filter((item) =>
      variants.some(
        (row) =>
          row.id === item.productVariantId && row.product_id === productId,
      ),
    )) {
      const rows = result.publication.rows.filter(
        (row) =>
          row.productVariantId === item.productVariantId &&
          row.publicationTargetId === request.publicationTargetId,
      );
      const row = rows[0];
      if (
        rows.length !== 1 ||
        row.publicationTargetRevision !== request.expectedTargetRevision ||
        row.channelConnectionId !== request.channelConnectionId ||
        row.externalScopeId !== request.shipNodeId ||
        row.providerKey !== "walmart"
      )
        return fail(
          "PUBLICATION_SETUP_QUANTITY_SCOPE_CHANGED",
          "The inventory destination changed. Review the listing again.",
        );
      if (row.blockerCodes.length)
        return fail(
          "PUBLICATION_SETUP_ATP_NOT_READY",
          `Stock cannot be calculated for ${item.sku}: ${row.blockerCodes.join(", ")}.`,
        );
      const quantity = BigInt(row.desiredQuantity);
      if (quantity < BigInt(0) || quantity > BigInt(2_147_483_647))
        return fail(
          "PUBLICATION_SETUP_QUANTITY_OUT_OF_RANGE",
          "The calculated stock exceeds the supported Walmart quantity range.",
        );
      quantities.set(item.productVariantId, Number(quantity));
    }
  }
  if (quantities.size !== request.items.length)
    return fail(
      "PUBLICATION_SETUP_VARIANT_CHANGED",
      "A selected variant is missing from current inventory.",
    );
  return validateListingSetupIntent({
    ...request,
    items: request.items.map((item) => ({
      ...item,
      quantity: quantities.get(item.productVariantId)!,
    })),
  });
}

const fail = (code: string, message: string): never => {
  throw new QuantityPublicationAdmissionError(code, message);
};
export type ListingSetupReadinessCache = Map<
  number,
  {
    snapshot: Awaited<
      ReturnType<typeof captureActiveSupplySnapshotInsideTransaction>
    >;
    configured: ActiveInventoryPublicationTargetSnapshot | undefined;
  }
>;

/** Runs inside the admission owner's SERIALIZABLE transaction, while global
 * and exact SKU session locks are held. No provider or authority mutation. */
export async function validateListingSetupReadinessInsideTransaction(
  client: PoolClient,
  intent: Readonly<ListingSetupIntent>,
  cache?: ListingSetupReadinessCache,
): Promise<void> {
  const target = (
    await client.query<{ warehouse_id: number }>(
      `SELECT w.warehouse_id
    FROM inventory.inventory_publication_targets t
    JOIN channels.channels c ON c.id=t.channel_id AND c.provider='walmart' AND c.status='active'
    JOIN channels.channel_connections cc ON cc.id=t.channel_connection_id AND cc.channel_id=c.id
    JOIN channels.walmart_connections w ON w.channel_id=c.id AND w.connection_id=cc.id
    JOIN inventory.availability_runtime_authority a ON a.singleton_key=true AND a.authority='canonical'
    JOIN inventory.availability_activation_runs r ON r.id=a.activation_run_id AND r.mode='activation' AND r.state='active'
    WHERE t.id=$1 AND t.revision=$2::bigint AND t.channel_id=$3 AND t.channel_connection_id=$4
      AND t.destination_kind='channel_connection' AND t.provider_scope_type='location' AND t.external_scope_id=$5
      AND t.state='live' AND t.publication_authority='echelon'
      AND w.partner_id=$6 AND w.environment=$7 AND w.ship_node_id=$5
    FOR SHARE OF t,c,cc,w,a,r`,
      [
        intent.publicationTargetId,
        intent.expectedTargetRevision,
        intent.channelId,
        intent.channelConnectionId,
        intent.shipNodeId,
        intent.partnerId,
        intent.environment,
      ],
    )
  ).rows[0];
  if (!target)
    fail(
      "PUBLICATION_SETUP_DESTINATION_NOT_READY",
      "Initial listing stock requires the reviewed active canonical Walmart account and destination.",
    );
  const variants = (
    await client.query<{ id: number; product_id: number; sku: string | null }>(
      `SELECT v.id,v.product_id,COALESCE(o.sku_override,v.sku) AS sku
    FROM catalog.product_variants v JOIN catalog.products p ON p.id=v.product_id
    LEFT JOIN channels.channel_variant_overrides o ON o.channel_id=$2 AND o.product_variant_id=v.id
    WHERE v.id=ANY($1::integer[]) AND p.is_active=true AND p.status='active' AND v.is_active=true AND v.requires_shipping=true
      AND v.track_inventory IS TRUE AND v.sales_eligibility='sellable' ORDER BY v.id FOR SHARE OF v,p`,
      [intent.items.map((item) => item.productVariantId), intent.channelId],
    )
  ).rows;
  if (
    variants.length !== intent.items.length ||
    variants.some(
      (variant) =>
        variant.sku !==
        intent.items.find((item) => item.productVariantId === variant.id)?.sku,
    )
  ) {
    fail(
      "PUBLICATION_SETUP_VARIANT_CHANGED",
      "The exact selected local variants and seller SKUs must remain active and unchanged.",
    );
  }
  const existing = await client.query<{
    product_variant_id: number;
    channel_sku: string;
    channel_inventory_item_id: string;
    channel_product_id: string | null;
    is_active: number;
    quarantined_at: Date | null;
  }>(
    `SELECT product_variant_id,channel_sku,channel_inventory_item_id,channel_product_id,is_active,quarantined_at
    FROM channels.channel_feeds WHERE channel_id=$1
    AND (product_variant_id=ANY($2::integer[]) OR channel_sku=ANY($3::text[])) FOR SHARE`,
    [
      intent.channelId,
      intent.items.map((item) => item.productVariantId),
      intent.items.map((item) => item.sku),
    ],
  );
  for (const row of existing.rows) {
    const item = intent.items.find(
      (value) =>
        value.productVariantId === row.product_variant_id &&
        value.sku === row.channel_sku,
    );
    if (!item?.recreation)
      return fail(
        "PUBLICATION_SETUP_ITEM_ALREADY_LINKED",
        "This SKU already has a listing link. Use Recreate on Walmart only after Walmart confirms the old listing is deleted.",
      );
    if (
      row.channel_inventory_item_id !== item.sku ||
      row.is_active !== 1 ||
      row.quarantined_at !== null ||
      row.channel_product_id !== item.recreation.previousExternalProductId ||
      existing.rows.filter(
        (value) =>
          value.product_variant_id === item.productVariantId ||
          value.channel_sku === item.sku,
      ).length !== 1
    )
      fail(
        "PUBLICATION_SETUP_RECREATION_IDENTITY_CHANGED",
        "The retained Walmart link changed after recreation was reviewed. Review this SKU again before publishing.",
      );
  }
  const recreatedItems = intent.items.filter((item) => item.recreation);
  if (recreatedItems.length) {
    const heads = await client.query<{
      product_variant_id: number;
      draft_mapping_id: number | null;
      lifecycle_status: string | null;
      external_inventory_item_id: string | null;
      external_sku: string | null;
    }>(
      `
      SELECT h.product_variant_id,h.draft_mapping_id,m.lifecycle_status,m.external_inventory_item_id,m.external_sku
      FROM inventory.publication_variant_mapping_heads h LEFT JOIN inventory.publication_variant_mapping_versions m ON m.id=h.active_mapping_id
      WHERE h.publication_target_id=$1 AND h.product_variant_id=ANY($2::integer[]) FOR SHARE OF h`,
      [
        intent.publicationTargetId,
        recreatedItems.map((item) => item.productVariantId),
      ],
    );
    if (
      heads.rows.some((head) => {
        const item = recreatedItems.find(
          (item) => item.productVariantId === head.product_variant_id,
        )!;
        return (
          head.draft_mapping_id !== null ||
          head.lifecycle_status !== "sealed" ||
          head.external_inventory_item_id !== item.sku ||
          head.external_sku !== item.sku
        );
      })
    )
      fail(
        "PUBLICATION_SETUP_RECREATION_MAPPING_REVIEW_REQUIRED",
        "This SKU has an unfinished or conflicting stock mapping. Review its mapping in Channel Inventory before recreating the Walmart listing.",
      );
  }
  for (const productId of [
    ...new Set(variants.map((variant) => variant.product_id)),
  ].sort((a, b) => a - b)) {
    let evidence = cache?.get(productId);
    if (!evidence) {
      const snapshot = await captureActiveSupplySnapshotInsideTransaction(
        client,
        productId,
      );
      const managedIds = await loadManagedSellableVariantIds(client, productId);
      const configured = (
        await loadActivePublicationTargets(
          client,
          productId,
          managedIds,
          intent.channelId,
        )
      ).find(
        (candidate) =>
          candidate.publicationTargetId === intent.publicationTargetId,
      );
      evidence = { snapshot, configured };
      cache?.set(productId, evidence);
    }
    const { snapshot, configured } = evidence;
    if (
      !snapshot.transformationModels.some(
        (model) =>
          model.productId === productId &&
          model.lifecycleSelection === "active_head" &&
          model.lifecycleStatus === "sealed" &&
          model.validationState === "valid",
      )
    ) {
      fail(
        "PUBLICATION_SETUP_PRODUCT_MODEL_NOT_READY",
        "Seal and activate a valid inventory model for the selected product before listing setup.",
      );
    }
    if (!configured)
      return fail(
        "PUBLICATION_SETUP_SOURCE_NOT_READY",
        "Configure a live publication target for the selected product.",
      );
    const sources = configured.sourceBinding?.members ?? [];
    if (
      !sources.length ||
      sources.some(
        (source) =>
          source.fulfillmentNodeLifecycleStatus !== "active" ||
          source.warehouseId !== target.warehouse_id,
      ) ||
      !snapshot.warehouses.some(
        (warehouse) =>
          warehouse.id === target.warehouse_id && warehouse.isActive,
      )
    ) {
      fail(
        "PUBLICATION_SETUP_SOURCE_NOT_READY",
        "Initial item setup requires sealed active supply from the configured fulfillment warehouse.",
      );
    }
    for (const variant of variants.filter(
      (candidate) => candidate.product_id === productId,
    )) {
      if (
        !snapshot.variants.some(
          (candidate) => candidate.id === variant.id && candidate.isActive,
        )
      ) {
        fail(
          "PUBLICATION_SETUP_PRODUCT_NOT_READY",
          "The selected variant is absent from the active inventory model.",
        );
      }
      const policy = resolveChannelExposurePolicy({
        channelId: intent.channelId,
        productId,
        productVariantId: variant.id,
        policies: configured.policies,
      });
      if (!policy.policy)
        fail(
          "PUBLICATION_SETUP_POLICY_NOT_READY",
          "Complete the selected SKU's inventory selling rules before listing setup.",
        );
      const override = resolveChannelSourceOverride({
        channelId: intent.channelId,
        productId,
        productVariantId: variant.id,
        policies: configured.policies,
      });
      if (
        override &&
        override.fulfillmentNodeIds.some(
          (nodeId) =>
            !configured.sourceOverrideMembers?.some(
              (member) =>
                member.fulfillmentNodeId === nodeId &&
                member.fulfillmentNodeLifecycleStatus === "active" &&
                member.warehouseId === target.warehouse_id,
            ),
        )
      ) {
        fail(
          "PUBLICATION_SETUP_SOURCE_OVERRIDE_NOT_READY",
          "The selected SKU's inventory source must match the configured Walmart fulfillment warehouse.",
        );
      }
      const item = intent.items.find(
        (value) => value.productVariantId === variant.id,
      )!;
      const mappings = configured.mappings.filter(
        (mapping) => mapping.productVariantId === variant.id,
      );
      if (mappings.length && !item.recreation) {
        fail(
          "PUBLICATION_SETUP_ALREADY_MANAGED",
          "Initial item setup cannot replace an existing inventory listing mapping.",
        );
      }
      if (
        item.recreation &&
        mappings.some(
          (mapping) =>
            mapping.externalInventoryItemId !== item.sku ||
            mapping.externalSku !== item.sku,
        )
      )
        fail(
          "PUBLICATION_SETUP_RECREATION_IDENTITY_CHANGED",
          "The retained stock mapping does not match the exact Walmart SKU being recreated. Review its listing mapping.",
        );
    }
  }
}

/** Persists exact scopes before HTTP. The surrounding admission transaction and
 * session locks keep target lifecycle commands from racing an unknown SKU. */
export async function admitListingSetupInsideTransaction(
  client: PoolClient,
  intent: Readonly<ListingSetupIntent>,
  now: Date,
): Promise<void> {
  await validateListingSetupReadinessInsideTransaction(client, intent);
  const alreadySubmitted = await client.query(
    `SELECT a.id FROM inventory.quantity_publication_attempts a
    LEFT JOIN inventory.quantity_publication_attempt_resolutions r ON r.attempt_id=a.id
    WHERE a.listing_setup_operation_id=$1 AND (a.state='succeeded' OR r.terminal_outcome='completed') LIMIT 1`,
    [intent.operationId],
  );
  if (alreadySubmitted.rows.length)
    fail(
      "PUBLICATION_SETUP_ALREADY_SUBMITTED",
      "This initial setup operation already has completed provider evidence; reconcile it instead of resubmitting.",
    );
  const requestHash = createHash("sha256")
    .update(canonicalJson(intent))
    .digest("hex");
  for (const item of intent.items) {
    // Inventory owns the permanent SKU identity and quantity admission. The
    // listing owner authorizes corrected batches after terminal item feedback;
    // an accepted feed is not proof that every individual item succeeded.
    const identity = (
      await client.query<{
        product_variant_id: number;
        external_inventory_item_id: string;
      }>(
        `SELECT product_variant_id,external_inventory_item_id FROM inventory.publication_listing_setup_identities
       WHERE publication_target_id=$1 AND (product_variant_id=$2 OR external_inventory_item_id=$3)`,
        [intent.publicationTargetId, item.productVariantId, item.sku],
      )
    ).rows;
    if (
      identity.some(
        (row) =>
          row.product_variant_id !== item.productVariantId ||
          row.external_inventory_item_id !== item.sku,
      )
    ) {
      fail(
        "PUBLICATION_SETUP_IDENTITY_CONFLICT",
        "The seller SKU or variant is already bound to another initial publication identity.",
      );
    }
    if (!identity.length)
      await client.query(
        `INSERT INTO inventory.publication_listing_setup_identities
      (publication_target_id,product_variant_id,external_inventory_item_id,created_at) VALUES($1,$2,$3,$4)`,
        [intent.publicationTargetId, item.productVariantId, item.sku, now],
      );
    const claims = (
      await client.query<{
        operation_id: string;
        request_hash: string;
        product_variant_id: number;
        external_inventory_item_id: string;
      }>(
        `SELECT operation_id,request_hash,product_variant_id,external_inventory_item_id FROM inventory.publication_listing_setup_scopes
       WHERE operation_id=$1 AND product_variant_id=$2`,
        [intent.operationId, item.productVariantId],
      )
    ).rows;
    if (claims.length) {
      if (
        claims.length !== 1 ||
        claims[0].operation_id !== intent.operationId ||
        claims[0].request_hash !== requestHash ||
        claims[0].product_variant_id !== item.productVariantId ||
        claims[0].external_inventory_item_id !== item.sku
      ) {
        fail(
          "PUBLICATION_SETUP_IDENTITY_CONFLICT",
          "The target SKU or variant belongs to another initial publication intent.",
        );
      }
    } else {
      await client.query(
        `INSERT INTO inventory.publication_listing_setup_scopes
        (publication_target_id,product_variant_id,external_inventory_item_id,operation_id,request_hash,desired_quantity,target_revision,created_at,recreation_evidence,quantity_source)
        VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8::jsonb,'canonical_at_submission')`,
        [
          intent.publicationTargetId,
          item.productVariantId,
          item.sku,
          intent.operationId,
          requestHash,
          intent.expectedTargetRevision,
          now,
          item.recreation ? JSON.stringify(item.recreation) : null,
        ],
      );
    }
  }
}
