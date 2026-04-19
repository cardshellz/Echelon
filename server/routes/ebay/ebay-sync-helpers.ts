import { pool, db } from "../../db";
import { EBAY_CHANNEL_ID, getAuthService, getChannelConnection, ebayApiRequest, atpService } from "./ebay-utils";

export interface SyncFilter { productIds?: number[]; productTypeSlugs?: string[]; variantIds?: number[]; }

export async function upsertChannelListing(
  client: any,
  channelId: number,
  productVariantId: number,
  data: {
    externalProductId?: string | null;
    externalVariantId?: string | null;
    externalSku?: string | null;
    externalUrl?: string | null;
    syncStatus?: string;
    syncError?: string | null;
    lastSyncedPrice?: number | null;
    lastSyncedQty?: number | null;
  }
): Promise<void> {
  await client.query(`
    INSERT INTO channel_listings (
      channel_id, product_variant_id, external_product_id, external_variant_id,
      external_sku, external_url, sync_status, sync_error,
      last_synced_price, last_synced_qty, last_synced_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW(), NOW())
    ON CONFLICT (channel_id, product_variant_id)
    DO UPDATE SET
      external_product_id = COALESCE(EXCLUDED.external_product_id, channel_listings.external_product_id),
      external_variant_id = COALESCE(EXCLUDED.external_variant_id, channel_listings.external_variant_id),
      external_sku = COALESCE(EXCLUDED.external_sku, channel_listings.external_sku),
      external_url = COALESCE(EXCLUDED.external_url, channel_listings.external_url),
      sync_status = EXCLUDED.sync_status,
      sync_error = EXCLUDED.sync_error,
      last_synced_price = EXCLUDED.last_synced_price,
      last_synced_qty = EXCLUDED.last_synced_qty,
      last_synced_at = NOW(),
      updated_at = NOW()
  `, [
    channelId,
    productVariantId,
    data.externalProductId || null,
    data.externalVariantId || null,
    data.externalSku || null,
    data.externalUrl || null,
    data.syncStatus || "pending",
    data.syncError || null,
    data.lastSyncedPrice || null,
    data.lastSyncedQty || null,
  ]);
}

// ---------------------------------------------------------------------------
// Push Error Helpers — store/clear per-product push errors
// ---------------------------------------------------------------------------

/**
 * Store the last push error for a product (across all its variants).
 * Uses the first variant's channel_listing row to store the error.
 */
export async function upsertPushError(client: any, channelId: number, productId: number, error: string): Promise<void> {
  // Find all variant IDs for this product
  const varResult = await client.query(
    `SELECT id FROM catalog.product_variants WHERE product_id = $1 AND sku IS NOT NULL AND is_active = true LIMIT 1`,
    [productId],
  );
  if (varResult.rows.length > 0) {
    const variantId = varResult.rows[0].id;
    await upsertChannelListing(client, channelId, variantId, {
      syncStatus: "error",
      syncError: error.substring(0, 1000),
    });
  }
}

/**
 * Clear push error for a product (across all its variants).
 */
export async function clearPushError(client: any, channelId: number, productId: number): Promise<void> {
  await client.query(
    `UPDATE channel_listings SET sync_error = NULL
     WHERE channel_id = $1 AND product_variant_id IN (
       SELECT id FROM product_variants WHERE product_id = $2
     )`,
    [channelId, productId],
  );
}

// ---------------------------------------------------------------------------
// Price Resolution — hierarchical pricing rules
// ---------------------------------------------------------------------------

/**
 * Resolve the effective channel price for a variant.
 * Priority: variant > product > category > channel > base price
 */
export async function resolveChannelPrice(
  client: any,
  channelId: number,
  productId: number,
  variantId: number,
  basePriceCents: number,
): Promise<number> {
  // 1. Check variant-level rule
  const variantRule = await client.query(
    `SELECT rule_type, value FROM channel_pricing_rules
     WHERE channel_id = $1 AND scope = 'variant' AND scope_id = $2::text`,
    [channelId, variantId],
  );
  if (variantRule.rows.length > 0) {
    return applyPricingRule(basePriceCents, variantRule.rows[0].rule_type, parseFloat(variantRule.rows[0].value));
  }

  // 2. Check product-level rule
  const productRule = await client.query(
    `SELECT rule_type, value FROM channel_pricing_rules
     WHERE channel_id = $1 AND scope = 'product' AND scope_id = $2::text`,
    [channelId, productId],
  );
  if (productRule.rows.length > 0) {
    return applyPricingRule(basePriceCents, productRule.rows[0].rule_type, parseFloat(productRule.rows[0].value));
  }

  // 3. Check category-level rule (lookup product's product_type)
  const productTypeResult = await client.query(
    `SELECT product_type FROM catalog.products WHERE id = $1`,
    [productId],
  );
  if (productTypeResult.rows.length > 0 && productTypeResult.rows[0].product_type) {
    const categoryRule = await client.query(
      `SELECT rule_type, value FROM channel_pricing_rules
       WHERE channel_id = $1 AND scope = 'category' AND scope_id = $2`,
      [channelId, productTypeResult.rows[0].product_type],
    );
    if (categoryRule.rows.length > 0) {
      return applyPricingRule(basePriceCents, categoryRule.rows[0].rule_type, parseFloat(categoryRule.rows[0].value));
    }
  }

  // 4. Check channel-level rule
  const channelRule = await client.query(
    `SELECT rule_type, value FROM channel_pricing_rules
     WHERE channel_id = $1 AND scope = 'channel' AND scope_id IS NULL`,
    [channelId],
  );
  if (channelRule.rows.length > 0) {
    return applyPricingRule(basePriceCents, channelRule.rows[0].rule_type, parseFloat(channelRule.rows[0].value));
  }

  // 5. No rule — return base price
  return basePriceCents;
}

/**
 * Apply a pricing rule to a base price.
 * - percentage: basePriceCents * (1 + value/100) — value is percentage (e.g., 15.00 = 15%)
 * - fixed: basePriceCents + value*100 — value is dollars (e.g., 2.00 = $2.00)
 * - override: value*100 — value is the exact price in dollars (e.g., 39.99 = $39.99)
 */
export function applyPricingRule(basePriceCents: number, ruleType: string, value: number): number {
  switch (ruleType) {
    case "percentage":
      return Math.round(basePriceCents * (1 + value / 100));
    case "fixed":
      return basePriceCents + Math.round(value * 100);
    case "override":
      return Math.round(value * 100);
    default:
      return basePriceCents;
  }
}

// ---------------------------------------------------------------------------
// Variation Aspect Name Detection
// ---------------------------------------------------------------------------

/**
 * Determine the eBay variation aspect name from variant data.
 * Uses option1_name if available and consistent, otherwise infers from values.
 */
export function determineVariationAspectName(variants: any[]): string {
  // Check if all variants have the same option1_name
  const option1Names = variants
    .map((v) => v.option1_name)
    .filter((n) => n && n.trim());

  if (option1Names.length > 0) {
    const uniqueNames = [...new Set(option1Names)];
    if (uniqueNames.length === 1) {
      return uniqueNames[0];
    }
  }

  // Infer from values: check if they look like quantities
  const values = variants.map((v) => v.option1_value || v.name || "");
  const allNumeric = values.every((v) => /^\d+/.test(v));
  if (allNumeric) return "Pack Size";

  return "Style";
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Sync Active Listings — updates prices, quantities, policies, aspects
// ---------------------------------------------------------------------------

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));



export async function syncActiveListings(filter: SyncFilter | null): Promise<{
  synced: number;
  priceChanges: number;
  qtyChanges: number;
  policyChanges: number;
  errors: number;
  details: Array<{
    productId: number;
    productName: string;
    variantSku: string;
    success: boolean;
    priceChanged: boolean;
    qtyChanged: boolean;
    policyChanged: boolean;
    error?: string;
  }>;
}> {
  const authService = getAuthService();
  if (!authService) {
    throw new Error("eBay OAuth not configured");
  }

  const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);

  // Get connection metadata (default policies)
  const conn = await getChannelConnection();
  const metadata = (conn?.metadata as Record<string, any>) || {};
  const defaultPolicies = {
    fulfillmentPolicyId: metadata.fulfillmentPolicyId || null,
    returnPolicyId: metadata.returnPolicyId || null,
    paymentPolicyId: metadata.paymentPolicyId || null,
  };
  const merchantLocationKey = metadata.merchantLocationKey || "card-shellz-hq";

  const client = await pool.connect();
  try {
    // Build the filter clause for active listings
    let filterClause = "";
    const params: any[] = [EBAY_CHANNEL_ID];
    let paramIdx = 2;

    if (filter?.productIds && filter.productIds.length > 0) {
      filterClause += ` AND p.id = ANY($${paramIdx})`;
      params.push(filter.productIds);
      paramIdx++;
    }
    if (filter?.productTypeSlugs && filter.productTypeSlugs.length > 0) {
      filterClause += ` AND p.product_type = ANY($${paramIdx})`;
      params.push(filter.productTypeSlugs);
      paramIdx++;
    }
    if (filter?.variantIds && filter.variantIds.length > 0) {
      filterClause += ` AND pv.id = ANY($${paramIdx})`;
      params.push(filter.variantIds);
      paramIdx++;
    }

    // Get all synced listings with their product/variant data
    const listingsResult = await client.query(`
      SELECT
        cl.id AS listing_id,
        cl.product_variant_id,
        cl.external_product_id,
        cl.external_variant_id,
        cl.external_sku,
        cl.last_synced_price,
        cl.last_synced_qty,
        pv.id AS variant_id,
        pv.sku AS variant_sku,
        pv.name AS variant_name,
        pv.price_cents,
        pv.option1_name,
        pv.option1_value,
        pv.ebay_fulfillment_policy_override AS variant_fulfillment_override,
        pv.ebay_return_policy_override AS variant_return_override,
        pv.ebay_payment_policy_override AS variant_payment_override,
        p.id AS product_id,
        p.name AS product_name,
        p.sku AS product_sku,
        p.description AS product_description,
        p.brand AS product_brand,
        p.product_type,
        p.ebay_browse_category_id,
        p.ebay_fulfillment_policy_override AS product_fulfillment_override,
        p.ebay_return_policy_override AS product_return_override,
        p.ebay_payment_policy_override AS product_payment_override
      FROM channels.channel_listings cl
      JOIN catalog.product_variants pv ON pv.id = cl.product_variant_id
      JOIN catalog.products p ON p.id = pv.product_id
      WHERE cl.channel_id = $1
        AND cl.sync_status = 'synced'
        ${filterClause}
      ORDER BY p.id ASC, pv.position ASC, pv.id ASC
    `, params);

    if (listingsResult.rows.length === 0) {
      return { synced: 0, priceChanges: 0, qtyChanges: 0, policyChanges: 0, errors: 0, details: [] };
    }

    // Group listings by product
    const productGroups: Map<number, any[]> = new Map();
    for (const row of listingsResult.rows) {
      const pid = row.product_id;
      if (!productGroups.has(pid)) productGroups.set(pid, []);
      productGroups.get(pid)!.push(row);
    }

    const summary = {
      synced: 0,
      priceChanges: 0,
      qtyChanges: 0,
      policyChanges: 0,
      errors: 0,
      details: [] as any[],
    };

    // Process products sequentially
    for (const [productId, variants] of productGroups) {
      const product = variants[0]; // product data is same for all variants

      // Get effective eBay category
      let ebayBrowseCategoryId = product.ebay_browse_category_id;
      let effectivePolicies = { ...defaultPolicies };

      // Category-level overrides
      if (product.product_type) {
        const catResult = await client.query(
          `SELECT ebay_browse_category_id, ebay_store_category_name,
                  fulfillment_policy_override, return_policy_override, payment_policy_override
           FROM ebay_category_mappings
           WHERE channel_id = $1 AND product_type_slug = $2`,
          [EBAY_CHANNEL_ID, product.product_type],
        );
        if (catResult.rows.length > 0) {
          const catRow = catResult.rows[0];
          if (!ebayBrowseCategoryId) ebayBrowseCategoryId = catRow.ebay_browse_category_id;
          if (catRow.fulfillment_policy_override) effectivePolicies.fulfillmentPolicyId = catRow.fulfillment_policy_override;
          if (catRow.return_policy_override) effectivePolicies.returnPolicyId = catRow.return_policy_override;
          if (catRow.payment_policy_override) effectivePolicies.paymentPolicyId = catRow.payment_policy_override;
        }
      }

      // Product-level policy overrides
      if (product.product_fulfillment_override) effectivePolicies.fulfillmentPolicyId = product.product_fulfillment_override;
      if (product.product_return_override) effectivePolicies.returnPolicyId = product.product_return_override;
      if (product.product_payment_override) effectivePolicies.paymentPolicyId = product.product_payment_override;

      // Build product-level aspects
      const aspects: Record<string, string[]> = {};
      if (product.product_brand) aspects["Brand"] = [product.product_brand];

      if (product.product_type) {
        const typeDefaults = await client.query(
          `SELECT aspect_name, aspect_value FROM ebay_type_aspect_defaults WHERE product_type_slug = $1`,
          [product.product_type],
        );
        for (const td of typeDefaults.rows) aspects[td.aspect_name] = [td.aspect_value];
      }
      const prodOverrides = await client.query(
        `SELECT aspect_name, aspect_value FROM ebay_product_aspect_overrides WHERE product_id = $1`,
        [productId],
      );
      for (const po of prodOverrides.rows) aspects[po.aspect_name] = [po.aspect_value];

      // Get images
      const imgResult = await client.query(
        `SELECT url FROM catalog.product_assets WHERE product_id = $1 ORDER BY position ASC`,
        [productId],
      );
      const imageUrls = imgResult.rows
        .map((r: any) => r.url)
        .filter((url: string) => url && url.startsWith("https://"))
        .slice(0, 12);

      // If no images in Echelon, fetch existing images from eBay to avoid wiping them
      let effectiveImageUrls = imageUrls;
      if (effectiveImageUrls.length === 0) {
        try {
          const firstSku = variants[0]?.variant_sku;
          if (firstSku) {
            const existingItem = await ebayApiRequest(
              "GET",
              `/sell/inventory/v1/inventory_item/${encodeURIComponent(firstSku)}`,
              accessToken,
            );
            if (existingItem?.product?.imageUrls?.length > 0) {
              effectiveImageUrls = existingItem.product.imageUrls;
              console.log(`[eBay Sync] Using ${effectiveImageUrls.length} existing eBay images for product (no Echelon assets)`);
            }
          }
        } catch (e: any) {
          console.warn(`[eBay Sync] Could not fetch existing images from eBay:`, e.message);
        }
      }

      const isMultiVariant = variants.length > 1;
      const variationAspectName = isMultiVariant ? determineVariationAspectName(variants) : "";

      // ---- Fetch fungible ATP for this product (shared pool) ----
      const syncVariantAtps = await atpService.getAtpPerVariant(productId);
      const syncAtpByVariantId: Map<number, number> = new Map();
      for (const va of syncVariantAtps) {
        syncAtpByVariantId.set(va.productVariantId, va.atpUnits);
      }

      // ---- Process each variant ----
      for (const variant of variants) {
        const sku = variant.variant_sku;
        try {
          // Recalculate price
          const newPriceCents = await resolveChannelPrice(
            client, EBAY_CHANNEL_ID, productId, variant.variant_id, variant.price_cents,
          );
          const priceInDollars = (newPriceCents / 100).toFixed(2);

          // Recalculate available quantity (fungible ATP)
          const newQty = Math.max(0, syncAtpByVariantId.get(variant.variant_id) ?? 0);

          // Detect changes
          const oldPrice = variant.last_synced_price || 0;
          const oldQty = variant.last_synced_qty || 0;
          const priceChanged = newPriceCents !== oldPrice;
          const qtyChanged = newQty !== oldQty;

          // Build variant aspects
          const variantAspects: Record<string, string[]> = { ...aspects };
          if (isMultiVariant) {
            const variationValue = variant.option1_value || variant.variant_name || sku;
            variantAspects[variationAspectName] = [variationValue];
          }

          // A. Update inventory item
          const inventoryItemBody: Record<string, any> = {
            condition: "NEW",
            product: {
              title: product.product_name.length > 80 ? product.product_name.substring(0, 77) + "..." : product.product_name,
              ...(effectiveImageUrls.length > 0 ? { imageUrls: effectiveImageUrls } : {}),
              aspects: variantAspects,
            },
            availability: {
              shipToLocationAvailability: { quantity: newQty },
            },
          };
          // Always include description — eBay requires it
          inventoryItemBody.product.description = product.product_description || `<p>${product.product_name}</p>`;

          console.log(`[eBay Sync] Updating inventory item: ${sku}`);
          await ebayApiRequest("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, accessToken, inventoryItemBody);
          await delay(200);

          // B. Update offer — find existing, then update
          let policyChanged = false;
          try {
            const offersResp = await ebayApiRequest(
              "GET",
              `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=EBAY_US`,
              accessToken,
            );
            await delay(200);

            if (offersResp?.offers?.length > 0) {
              const existingOffer = offersResp.offers[0];
              const offerId = existingOffer.offerId;

              // Variant-level policy overrides
              const variantPolicies = {
                fulfillmentPolicyId: variant.variant_fulfillment_override || effectivePolicies.fulfillmentPolicyId,
                returnPolicyId: variant.variant_return_override || effectivePolicies.returnPolicyId,
                paymentPolicyId: variant.variant_payment_override || effectivePolicies.paymentPolicyId,
              };

              // Detect policy changes
              const oldPolicies = existingOffer.listingPolicies || {};
              if (
                oldPolicies.fulfillmentPolicyId !== variantPolicies.fulfillmentPolicyId ||
                oldPolicies.returnPolicyId !== variantPolicies.returnPolicyId ||
                oldPolicies.paymentPolicyId !== variantPolicies.paymentPolicyId
              ) {
                policyChanged = true;
              }

              // Get store category names
              let storeCategoryNames: string[] = [];
              if (product.product_type) {
                const scResult = await client.query(
                  `SELECT ebay_store_category_name FROM ebay_category_mappings
                   WHERE channel_id = $1 AND product_type_slug = $2`,
                  [EBAY_CHANNEL_ID, product.product_type],
                );
                if (scResult.rows.length > 0 && scResult.rows[0].ebay_store_category_name) {
                  storeCategoryNames = [scResult.rows[0].ebay_store_category_name];
                }
              }

              const offerBody: Record<string, any> = {
                sku,
                marketplaceId: "EBAY_US",
                format: "FIXED_PRICE",
                categoryId: ebayBrowseCategoryId,
                listingPolicies: variantPolicies,
                merchantLocationKey,
                pricingSummary: {
                  price: { value: priceInDollars, currency: "USD" },
                },
                availableQuantity: newQty,
              };
              if (storeCategoryNames.length > 0) {
                offerBody.storeCategoryNames = storeCategoryNames;
              }

              console.log(`[eBay Sync] Updating offer ${offerId} for SKU: ${sku}`);
              await ebayApiRequest("PUT", `/sell/inventory/v1/offer/${offerId}`, accessToken, offerBody);
              await delay(200);
            }
          } catch (offerErr: any) {
            console.error(`[eBay Sync] Offer update failed for ${sku}:`, offerErr.message);
            // Non-fatal — inventory item was still updated
          }

          // Update channel_listings with new synced values
          await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.variant_id, {
            lastSyncedPrice: newPriceCents,
            lastSyncedQty: newQty,
            syncStatus: "synced",
            syncError: null,
          });

          summary.synced++;
          if (priceChanged) summary.priceChanges++;
          if (qtyChanged) summary.qtyChanges++;
          if (policyChanged) summary.policyChanges++;

          summary.details.push({
            productId,
            productName: product.product_name,
            variantSku: sku,
            success: true,
            priceChanged,
            qtyChanged,
            policyChanged,
          });

        } catch (err: any) {
          console.error(`[eBay Sync] Error syncing SKU ${sku}:`, err.message);
          summary.errors++;
          summary.details.push({
            productId,
            productName: product.product_name,
            variantSku: sku,
            success: false,
            priceChanged: false,
            qtyChanged: false,
            policyChanged: false,
            error: err.message.substring(0, 500),
          });
          await delay(200);
        }
      }

      // C. Update inventory item group if multi-variant
      if (isMultiVariant) {
        try {
          const groupKey = product.product_sku || `PROD-${productId}`;
          const successfulSkus = variants.map((v: any) => v.variant_sku);

          const variationValues = variants.map(
            (v: any) => v.option1_value || v.variant_name || v.variant_sku,
          );

          const groupBody: Record<string, any> = {
            title: product.product_name.length > 80 ? product.product_name.substring(0, 77) + "..." : product.product_name,
            description: product.product_description || `<p>${product.product_name}</p>`,
            ...(effectiveImageUrls.length > 0 ? { imageUrls: effectiveImageUrls } : {}),
            aspects,
            variantSKUs: successfulSkus,
            variesBy: {
              aspectsImageVariesBy: [],
              specifications: [
                {
                  name: variationAspectName,
                  values: variationValues,
                },
              ],
            },
          };

          console.log(`[eBay Sync] Updating inventory item group: ${groupKey}`);
          await ebayApiRequest(
            "PUT",
            `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
            accessToken,
            groupBody,
          );
          await delay(200);
        } catch (groupErr: any) {
          console.error(`[eBay Sync] Group update failed for product ${productId}:`, groupErr.message);
          // Non-fatal
        }
      }
    }

    console.log(`[eBay Sync] Complete: synced=${summary.synced} priceChanges=${summary.priceChanges} qtyChanges=${summary.qtyChanges} policyChanges=${summary.policyChanges} errors=${summary.errors}`);
    return summary;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Trigger Pricing Rule Sync — fire-and-forget background sync
// ---------------------------------------------------------------------------

export async function triggerPricingRuleSync(scope: string, scopeId: string | null): Promise<void> {
  console.log(`[eBay Pricing Rule Sync] Triggered: scope=${scope} scopeId=${scopeId}`);

  let filter: SyncFilter | null = null;

  switch (scope) {
    case "channel":
      // Sync ALL active listings
      filter = null;
      break;
    case "category":
      if (scopeId) {
        // Sync all listings in this product type
        filter = { productTypeSlugs: [scopeId] };
      }
      break;
    case "product":
      if (scopeId) {
        filter = { productIds: [parseInt(scopeId)] };
      }
      break;
    case "variant":
      if (scopeId) {
        filter = { variantIds: [parseInt(scopeId)] };
      }
      break;
  }

  const result = await syncActiveListings(filter);
  console.log(`[eBay Pricing Rule Sync] Complete: synced=${result.synced} priceChanges=${result.priceChanges} errors=${result.errors}`);
}
