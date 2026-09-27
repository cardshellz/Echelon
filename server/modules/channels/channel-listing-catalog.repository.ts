import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import {
  listingCatalogItemSchema,
  listingCatalogQuerySchema,
  listingPriceRuleSchema,
  type ListingCatalogItem,
  type ListingPriceRule,
} from "@shared/types/channel-listing-publication";
import { resolveChannelListingPrice } from "./channel-pricing-resolver";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import {
  ListingPublicationError,
  listingHash,
} from "../marketplace-listings/domain/listing-publication";

/** Channels owns catalog projection and its existing shared price rule tables. */
export class ChannelListingCatalogRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async catalog(
    channelId: number,
    input: unknown,
  ): Promise<{
    items: ListingCatalogItem[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const query = listingCatalogQuerySchema.parse(input);
    const variantIds = query.variantIds
      ?.split(",")
      .map((value) => Number(value));
    if (
      variantIds?.some(
        (id) => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647,
      )
    ) {
      throw new ListingPublicationError(
        "LISTING_VARIANT_INVALID",
        "Select valid Echelon variants",
        400,
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const where = `$1::int > 0 AND ($2::int[] IS NULL OR v.id=ANY($2::int[])) AND ($2::int[] IS NOT NULL OR (p.is_active AND v.is_active))
        AND ($3='' OR v.sku ILIKE '%' || $3 || '%' OR p.name ILIKE '%' || $3 || '%' OR v.name ILIKE '%' || $3 || '%')`;
      const parameters = [channelId, variantIds ?? null, query.q];
      const total = Number(
        (
          await client.query(
            `SELECT count(*)::int AS n FROM catalog.product_variants v JOIN catalog.products p ON p.id=v.product_id WHERE ${where}`,
            parameters,
          )
        ).rows[0].n,
      );
      const rows = (
        await client.query(
          `SELECT v.id AS variant_id, p.id AS product_id, coalesce(vo.sku_override,v.sku,'') AS sku,
        p.name, coalesce(vo.name_override,v.name) AS variant_name, v.uom_type, v.units_per_variant, p.base_unit, p.product_type,
        coalesce(po.title_override,p.title,p.name) AS title, coalesce(po.description_override,p.description) AS description, p.brand,
        coalesce(nullif(vo.barcode_override,''),nullif(v.gtin,''),nullif(v.barcode,'')) AS identifier,
        (p.is_active AND p.status='active' AND v.is_active AND v.requires_shipping AND v.track_inventory IS TRUE
          AND v.sales_eligibility='sellable' AND coalesce(po.is_listed,1)=1 AND coalesce(vo.is_listed,1)=1) AS eligible,
        EXISTS(SELECT 1 FROM channels.channel_listings l WHERE l.channel_id=$1 AND l.product_variant_id=v.id) AS already_linked,
        (SELECT currency FROM channels.channel_pricing cp WHERE cp.channel_id=$1 AND cp.product_variant_id=v.id LIMIT 1) AS channel_price_currency,
        coalesce((SELECT jsonb_agg(coalesce(ao.url_override,a.url) ORDER BY coalesce(ao.position_override,a.position),a.id)
          FROM catalog.product_assets a LEFT JOIN channels.channel_asset_overrides ao ON ao.product_asset_id=a.id AND ao.channel_id=$1
          WHERE a.product_id=p.id AND (a.product_variant_id IS NULL OR a.product_variant_id=v.id)
            AND a.asset_type='image' AND coalesce(ao.is_included,1)=1 AND coalesce(ao.url_override,a.url) IS NOT NULL), '[]'::jsonb) AS images
        FROM catalog.product_variants v JOIN catalog.products p ON p.id=v.product_id
        LEFT JOIN channels.channel_product_overrides po ON po.product_id=p.id AND po.channel_id=$1
        LEFT JOIN channels.channel_variant_overrides vo ON vo.product_variant_id=v.id AND vo.channel_id=$1
        WHERE ${where} ORDER BY p.name,v.position,v.id LIMIT $4 OFFSET $5`,
          [
            ...parameters,
            variantIds ? 100 : query.limit,
            variantIds ? 0 : query.offset,
          ],
        )
      ).rows;
      const items: ListingCatalogItem[] = [];
      const database = drizzle(client, { schema });
      for (const row of rows) {
        const resolved = await resolveChannelListingPrice(database, {
          channelId,
          productId: row.product_id,
          variantId: row.variant_id,
        });
        if (
          resolved.source === "channel_pricing" &&
          row.channel_price_currency !== "USD"
        ) {
          throw new ListingPublicationError(
            "LISTING_CURRENCY_UNSUPPORTED",
            `SKU ${row.sku} has a non-USD channel price. Set its Walmart price in USD before publishing.`,
            409,
          );
        }
        const identifier =
          typeof row.identifier === "string" && row.identifier.trim()
            ? row.identifier.trim()
            : null;
        const source = {
          variantId: row.variant_id,
          productId: row.product_id,
          sku: row.sku,
          name: row.name,
          variantName: row.variant_name,
          unitLabel: `1 ${row.uom_type} = ${row.units_per_variant} ${row.base_unit}${row.units_per_variant === 1 ? "" : "s"}`,
          productType: row.product_type,
          title: row.title,
          description: row.description,
          brand: row.brand,
          images: row.images,
          identifier: identifier
            ? {
                type:
                  identifier.length === 12
                    ? ("UPC" as const)
                    : identifier.length === 13
                      ? ("EAN" as const)
                      : ("GTIN" as const),
                value: identifier,
              }
            : null,
          priceCents: resolved.priceCents,
          basePriceCents: resolved.basePriceCents,
          priceSource: resolved.source,
          appliedRule: resolved.appliedRule
            ? listingPriceRuleSchema.parse({
                type: resolved.appliedRule.ruleType,
                value: resolved.appliedRule.value,
              })
            : null,
          appliedRuleScope: resolved.appliedRule?.scope ?? null,
          eligible: row.eligible,
          alreadyLinked: row.already_linked,
        };
        items.push(
          listingCatalogItemSchema.parse({
            ...source,
            sourceHash: listingHash(source),
          }),
        );
      }
      await client.query("COMMIT");
      return {
        items,
        total,
        offset: variantIds ? 0 : query.offset,
        limit: variantIds ? 100 : query.limit,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async pricingRule(channelId: number): Promise<ListingPriceRule | null> {
    const client = await this.pool.connect();
    try {
      const rows = (
        await client.query(
          "SELECT rule_type,value::text FROM channels.channel_pricing_rules WHERE channel_id=$1 AND scope='channel' AND scope_id IS NULL ORDER BY id",
          [channelId],
        )
      ).rows;
      if (rows.length > 1)
        throw new ListingPublicationError(
          "LISTING_PRICING_CONFLICT",
          "Multiple channel defaults exist; resolve the pricing rules before publishing",
        );
      return rows[0]
        ? listingPriceRuleSchema.parse({
            type: rows[0].rule_type,
            value: rows[0].value,
          })
        : null;
    } finally {
      client.release();
    }
  }

  async savePricingRule(
    channelId: number,
    input: unknown,
    actor: string,
    now: Date,
  ): Promise<ListingPriceRule> {
    const rule = listingPriceRuleSchema.parse(input);
    if (rule.type === "override" && /^0(?:\.0{1,2})?$/.test(rule.value))
      throw new ListingPublicationError(
        "LISTING_PRICE_INVALID",
        "A fixed selling price must be greater than zero",
        400,
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockChannel(client, channelId);
      const before = (
        await client.query(
          "SELECT id,rule_type,value::text FROM channels.channel_pricing_rules WHERE channel_id=$1 AND scope='channel' AND scope_id IS NULL FOR UPDATE",
          [channelId],
        )
      ).rows;
      if (before.length > 1)
        throw new ListingPublicationError(
          "LISTING_PRICING_CONFLICT",
          "Multiple channel defaults exist; resolve the pricing rules before publishing",
        );
      if (before.length)
        await client.query(
          "UPDATE channels.channel_pricing_rules SET rule_type=$2,value=$3,updated_at=$4 WHERE id=$1",
          [before[0].id, rule.type, rule.value, now],
        );
      else
        await client.query(
          "INSERT INTO channels.channel_pricing_rules(channel_id,scope,scope_id,rule_type,value,created_at,updated_at) VALUES ($1,'channel',NULL,$2,$3,$4,$4)",
          [channelId, rule.type, rule.value, now],
        );
      await persistAuditEvent(
        drizzle(client),
        {
          actor,
          action: "channel_listing.pricing_rule_saved",
          target: `channel:${channelId}`,
          changes: { before, after: rule },
        },
        { timestamp: now, emitStructuredLog: false },
      );
      await client.query("COMMIT");
      return rule;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
async function lockChannel(client: PoolClient, id: number): Promise<void> {
  if (
    (
      await client.query(
        "SELECT id FROM channels.channels WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rowCount !== 1
  ) {
    throw new ListingPublicationError(
      "LISTING_CHANNEL_MISSING",
      "Channel not found",
      404,
    );
  }
}
