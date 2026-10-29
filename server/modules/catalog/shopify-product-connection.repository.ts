import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  channelConnections, channelPricing, channels, products, productVariants,
} from "@shared/schema";
import {
  shopifyProductConnectionRequestSchema, type ShopifyProductConnectionCommand,
  type ShopifyProductConnectionRequest,
} from "@shared/catalog/shopify-product-connection";
import { resolveInventoryTrackingPolicy } from "@shared/catalog/inventory-tracking-policy";
import { db } from "../../db";
import { createCatalogPublicImageUrl, type CatalogPublicImageUrl } from "./catalog-public-image";
import { resolveCatalogPublicationImage, type CatalogPublicationImage } from "./catalog-publication-image";
import { MAX_PRODUCT_IMAGE_BYTES } from "./product-image-download.service";
import { createShopifyProductMappingService } from "./shopify-product-mapping.service";
import {
  connectionFingerprint, ShopifyProductConnectionError, type ShopifyConnectionCreateSpec,
  type ShopifyConnectionSource, type ShopifyConnectionReviewEvidence, resolveShopifyConnectionPrice,
} from "./shopify-product-connection.domain";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Client = typeof db | Transaction;
const COMMAND_LEASE_MS = 120_000;
const MAX_AUTOMATIC_ATTEMPTS = 8;
// This flow uses the verified 2026 product model. Older nullable connection
// settings remain compatible without changing any saved connection settings.
const MINIMUM_PRODUCT_API_VERSION = "2026-01";

function productApiVersion(configured: string | null): string {
  if (configured !== null && !/^20\d{2}-(01|04|07|10)$/.test(configured)) {
    throw new ShopifyProductConnectionError("SHOPIFY_API_VERSION_INVALID", "The Shopify connection has an invalid API version.", 422);
  }
  return configured && configured > MINIMUM_PRODUCT_API_VERSION ? configured : MINIMUM_PRODUCT_API_VERSION;
}

export interface ShopifyConnectionCredentials {
  connectionId: number;
  shopDomain: string;
  apiVersion: string;
  accessToken: string;
}

interface CommandRow {
  command_key: string; product_id: number; channel_id: number; connection_id: number;
  shop_domain: string; actor: string; request_hash: string; preview_hash: string;
  mode: "create" | "link"; request: ShopifyProductConnectionRequest;
  source_snapshot: ShopifyConnectionSource; review_evidence: ShopifyConnectionReviewEvidence; create_spec: ShopifyConnectionCreateSpec | null;
  state: ShopifyProductConnectionCommand["state"]; create_requested: boolean;
  remote_product_id: string | null; lease_token: string | null; lease_expires_at: Date | string | null;
  last_error_code: string | null; last_error_message: string | null; retryable: boolean;
  resume_attempt_count: number;
  result: Record<string, unknown> | null; completed_at: Date | string | null;
}

export interface StoredShopifyConnection extends ShopifyProductConnectionCommand {
  connectionId: number;
  shopDomain: string;
  source: ShopifyConnectionSource;
  review: ShopifyConnectionReviewEvidence;
  createSpec: ShopifyConnectionCreateSpec | null;
  createRequested: boolean;
  leaseToken: string | null;
  result: Record<string, unknown> | null;
  resumeAttemptCount: number;
}

export interface ShopifyConnectionReservation {
  commandKey: string;
  productId: number;
  request: ShopifyProductConnectionRequest;
  previewHash: string;
  source: ShopifyConnectionSource;
  review: ShopifyConnectionReviewEvidence;
  createSpec: ShopifyConnectionCreateSpec | null;
  actor: string;
}

function rows<T>(result: unknown): T[] {
  if (!result || typeof result !== "object" || !("rows" in result) || !Array.isArray(result.rows)) {
    throw new TypeError("The Shopify connection repository returned an invalid database result.");
  }
  return result.rows as T[];
}

function money(value: unknown): number | null {
  if (value === null) return null;
  if ((typeof value !== "string" && typeof value !== "number") || !/^(0|[1-9][0-9]*)$/.test(String(value))) {
    throw new ShopifyProductConnectionError("CATALOG_PRICE_INVALID", "A catalog price is not valid integer cents. Correct it before connecting this product.", 422);
  }
  const amount = BigInt(value);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ShopifyProductConnectionError("CATALOG_PRICE_INVALID", "A catalog price exceeds the supported safe integer range.", 422);
  }
  return Number(amount);
}

function intentHash(input: Omit<ShopifyConnectionReservation, "actor" | "commandKey">): string {
  return connectionFingerprint(input);
}

function decode(row: CommandRow): StoredShopifyConnection {
  const request = shopifyProductConnectionRequestSchema.parse(row.request);
  const calculated = intentHash({ productId: row.product_id, request, previewHash: row.preview_hash,
    source: row.source_snapshot, review: row.review_evidence, createSpec: row.create_spec });
  if (calculated !== row.request_hash || row.source_snapshot.channel.connectionId !== row.connection_id
    || row.source_snapshot.channel.shopDomain !== row.shop_domain || request.channelId !== row.channel_id) {
    throw new ShopifyProductConnectionError("SHOPIFY_CONNECTION_RECEIPT_INVALID", "The saved Shopify command's intent or account evidence is invalid. Review is required.", 409);
  }
  return {
    commandKey: row.command_key, productId: row.product_id, channelId: row.channel_id,
    mode: row.mode, state: row.state, remoteProductId: row.remote_product_id,
    request, previewHash: row.preview_hash, lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message, retryable: row.retryable,
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    connectionId: row.connection_id, shopDomain: row.shop_domain, source: row.source_snapshot, review: row.review_evidence,
    createSpec: row.create_spec, createRequested: row.create_requested, leaseToken: row.lease_token,
    result: row.result,
    resumeAttemptCount: row.resume_attempt_count,
  };
}

export function publicConnectionCommand(command: StoredShopifyConnection): ShopifyProductConnectionCommand {
  const { commandKey, productId, channelId, mode, state, remoteProductId, request, previewHash,
    lastErrorCode, lastErrorMessage, retryable, completedAt } = command;
  return { commandKey, productId, channelId, mode, state, remoteProductId, request, previewHash,
    lastErrorCode, lastErrorMessage, retryable, completedAt };
}

export function createShopifyProductConnectionRepository(input: {
  database?: typeof db;
  now?: () => Date;
  newLeaseToken?: () => string;
  publicImageUrl?: CatalogPublicImageUrl;
} = {}) {
  const database = input.database ?? db;
  const now = input.now ?? (() => new Date());
  const newLeaseToken = input.newLeaseToken ?? randomUUID;
  const publicImageUrl = input.publicImageUrl ?? createCatalogPublicImageUrl(process.env);
  const mapping = createShopifyProductMappingService({ database });

  async function configuredChannels() {
    return database.select({ id: channels.id, name: channels.name, isDefault: channels.isDefault })
      .from(channels).where(and(eq(channels.provider, "shopify"), eq(channels.status, "active")))
      .orderBy(desc(channels.isDefault), asc(channels.id));
  }

  async function credentials(channelId: number, expected?: { connectionId: number; shopDomain: string }): Promise<ShopifyConnectionCredentials> {
    const result = await database.select({ id: channelConnections.id, shopDomain: channelConnections.shopDomain,
      apiVersion: channelConnections.apiVersion, accessToken: channelConnections.accessToken })
      .from(channelConnections).where(eq(channelConnections.channelId, channelId)).orderBy(asc(channelConnections.id));
    if (result.length !== 1 || !result[0].accessToken || !result[0].shopDomain
      || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(result[0].shopDomain)) {
      throw new ShopifyProductConnectionError("SHOPIFY_CONNECTION_NOT_CONFIGURED", "This channel needs one valid Shopify store connection and API version.", 422);
    }
    const connection = result[0];
    if (expected && (connection.id !== expected.connectionId || connection.shopDomain !== expected.shopDomain)) {
      throw new ShopifyProductConnectionError("SHOPIFY_CONNECTION_CHANGED", "The Shopify store connection changed. Review the saved command before continuing.");
    }
    return { connectionId: connection.id, shopDomain: connection.shopDomain!, apiVersion: productApiVersion(connection.apiVersion), accessToken: connection.accessToken! };
  }

  async function readSource(client: Client, productId: number, channelId: number): Promise<ShopifyConnectionSource> {
    const [product] = await client.select().from(products).where(eq(products.id, productId)).limit(1);
    if (!product) throw new ShopifyProductConnectionError("PRODUCT_NOT_FOUND", "The catalog product was not found.", 404);
    if (product.tags !== null && (!Array.isArray(product.tags) || product.tags.some(tag => typeof tag !== "string"))) {
      throw new ShopifyProductConnectionError("SHOPIFY_TAGS_INVALID", "The catalog product's tags must be an array of text values.", 422);
    }
    const [channel] = await client.select({ id: channels.id, name: channels.name }).from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.provider, "shopify"), eq(channels.status, "active"))).limit(1);
    if (!channel) throw new ShopifyProductConnectionError("SHOPIFY_CHANNEL_UNAVAILABLE", "Select an active Shopify channel.", 422);
    const connections = await client.select({ id: channelConnections.id, shopDomain: channelConnections.shopDomain,
      apiVersion: channelConnections.apiVersion }).from(channelConnections)
      .where(eq(channelConnections.channelId, channelId)).orderBy(asc(channelConnections.id));
    if (connections.length !== 1 || !connections[0].shopDomain) {
      throw new ShopifyProductConnectionError("SHOPIFY_CONNECTION_NOT_CONFIGURED", "This channel needs one Shopify store connection.", 422);
    }
    const summary = await mapping.getSummary(productId, channelId, client);
    const variants = await client.select({
      id: productVariants.id, sku: productVariants.sku, name: productVariants.name,
      barcode: productVariants.barcode, isActive: productVariants.isActive,
      salesEligibility: productVariants.salesEligibility, requiresShipping: productVariants.requiresShipping,
      inventoryTrackingOverride: productVariants.inventoryTrackingOverride,
      channelPriceId: channelPricing.id, channelPrice: channelPricing.price,
      channelCompareAtPrice: channelPricing.compareAtPrice, channelCurrency: channelPricing.currency,
      catalogPrice: productVariants.priceCents, catalogCompareAtPrice: productVariants.compareAtPriceCents,
    }).from(productVariants).leftJoin(channelPricing, and(eq(channelPricing.productVariantId, productVariants.id), eq(channelPricing.channelId, channelId)))
      .where(eq(productVariants.productId, productId)).orderBy(asc(productVariants.id));
    // Metadata and file signatures only. Resolution stays with Catalog's shared
    // image owner, including content-addressed publication of uploaded photos.
    const images = rows<CatalogPublicationImage & { alt: string | null }>(await client.execute(sql`
      SELECT id,product_id AS "productId",product_variant_id AS "productVariantId",position,
        url,storage_type AS "storageType",mime_type AS "mimeType",alt_text AS alt,
        CASE WHEN storage_type IN ('file','both') AND url IS NULL THEN octet_length(file_data) END AS "fileBytes",
        CASE WHEN storage_type IN ('file','both') AND url IS NULL AND octet_length(file_data) BETWEEN 1 AND ${MAX_PRODUCT_IMAGE_BYTES}
          THEN encode(sha256(file_data),'hex') END AS "fileHash",
        CASE WHEN storage_type IN ('file','both') AND url IS NULL AND octet_length(file_data) BETWEEN 1 AND ${MAX_PRODUCT_IMAGE_BYTES}
          THEN substring(file_data FROM 1 FOR 12) END AS "fileHeader"
      FROM catalog.product_assets WHERE product_id=${productId} AND asset_type='image'
      ORDER BY is_primary DESC,position,id
    `)).filter(image => image.productVariantId === null || variants.some(variant =>
      variant.id === image.productVariantId && variant.isActive && variant.salesEligibility === "sellable"));
    return {
      product: { id: product.id, sku: product.sku, name: product.name, title: product.title,
        description: product.description, vendor: product.brand, productType: product.productType,
        tags: (product.tags ?? []) as string[], isActive: product.isActive, trackInventory: product.inventoryTrackingDefault },
      variants: variants.map(variant => ({ ...variant,
        trackInventory: resolveInventoryTrackingPolicy({ requiresShipping: variant.requiresShipping,
          inventoryTrackingOverride: variant.inventoryTrackingOverride, inventoryTrackingDefault: product.inventoryTrackingDefault }),
        ...resolveShopifyConnectionPrice({ primaryStore: summary.channel.isPrimary === true,
          catalogPrice: money(variant.catalogPrice), catalogCompareAtPrice: money(variant.catalogCompareAtPrice),
          channelPrice: money(variant.channelPrice), channelCompareAtPrice: money(variant.channelCompareAtPrice) }),
        priceCurrency: variant.channelPriceId === null ? summary.channel.isPrimary ? "USD" : null : variant.channelCurrency,
        channelPrice: variant.channelPriceId === null ? null : {
          price: String(money(variant.channelPrice)), compareAtPrice: variant.channelCompareAtPrice === null ? null : String(money(variant.channelCompareAtPrice)),
          currency: variant.channelCurrency!,
        },
      })),
      images: images.flatMap(image => {
        const url = resolveCatalogPublicationImage(image, publicImageUrl);
        return url === null ? [] : [{ url, alt: image.alt }];
      }),
      mapping: summary,
      channel: { id: channel.id, name: channel.name, shopDomain: connections[0].shopDomain,
        connectionId: connections[0].id, apiVersion: productApiVersion(connections[0].apiVersion) },
    };
  }

  async function source(productId: number, channelId: number): Promise<ShopifyConnectionSource> {
    return database.transaction(tx => readSource(tx, productId, channelId), { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function find(commandKey: string): Promise<StoredShopifyConnection | null> {
    const [row] = rows<CommandRow>(await database.execute(sql`SELECT * FROM catalog.shopify_product_connection_commands WHERE command_key=${commandKey}::uuid`));
    return row ? decode(row) : null;
  }

  async function pending(productId: number, channelId: number): Promise<StoredShopifyConnection | null> {
    const [row] = rows<CommandRow>(await database.execute(sql`SELECT * FROM catalog.shopify_product_connection_commands
      WHERE product_id=${productId} AND channel_id=${channelId} AND state NOT IN ('complete','rejected')`));
    return row ? decode(row) : null;
  }

  async function due(limit = 5): Promise<StoredShopifyConnection[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new TypeError("Invalid Shopify command batch size.");
    const at = now().toISOString();
    return rows<CommandRow>(await database.execute(sql`SELECT * FROM catalog.shopify_product_connection_commands
      WHERE state NOT IN ('complete','rejected') AND retryable AND next_attempt_at<=${at}::timestamptz
        AND (lease_expires_at IS NULL OR lease_expires_at<=${at}::timestamptz)
      ORDER BY next_attempt_at,created_at,command_key LIMIT ${limit}`)).map(decode);
  }

  async function event(client: Client, commandKey: string, actor: string, eventType: string, details: Record<string, unknown>, at: Date): Promise<void> {
    await client.execute(sql`INSERT INTO catalog.shopify_product_connection_events(command_key,actor,event_type,details,occurred_at)
      VALUES(${commandKey}::uuid,${actor},${eventType},${JSON.stringify(details)}::jsonb,${at.toISOString()}::timestamptz)`);
  }

  async function reserve(reservation: ShopifyConnectionReservation, options: { runNow?: boolean } = {}): Promise<StoredShopifyConnection> {
    return database.transaction(async tx => {
      // The product row serializes different command keys for this resource;
      // the partial unique index remains the final cross-process owner guard.
      await tx.execute(sql`SELECT id FROM catalog.products WHERE id=${reservation.productId} FOR UPDATE`);
      const [existing] = rows<CommandRow>(await tx.execute(sql`SELECT * FROM catalog.shopify_product_connection_commands
        WHERE command_key=${reservation.commandKey}::uuid FOR UPDATE`));
      let row = existing;
      if (row) {
        const saved = decode(row);
        if (saved.productId !== reservation.productId || saved.channelId !== reservation.request.channelId
          || connectionFingerprint(saved.request) !== connectionFingerprint(reservation.request) || saved.previewHash !== reservation.previewHash) {
          throw new ShopifyProductConnectionError("SHOPIFY_COMMAND_KEY_REUSED", "This command key belongs to a different reviewed Shopify request.");
        }
        if (row.state === "complete" || row.state === "rejected") return saved;
      } else {
        const [active] = rows<{ command_key: string }>(await tx.execute(sql`SELECT command_key FROM catalog.shopify_product_connection_commands
          WHERE product_id=${reservation.productId} AND channel_id=${reservation.request.channelId} AND state NOT IN ('complete','rejected')`));
        if (active) throw new ShopifyProductConnectionError("SHOPIFY_COMMAND_PENDING", "This product already has an unfinished Shopify command. Resume it before starting another.");
        const current = await readSource(tx, reservation.productId, reservation.request.channelId);
        if (connectionFingerprint(current) !== connectionFingerprint(reservation.source)) {
          throw new ShopifyProductConnectionError("SHOPIFY_PREVIEW_STALE", "The catalog or Shopify connection changed. Refresh the review before continuing.");
        }
        const at = now();
        const [created] = rows<CommandRow>(await tx.execute(sql`INSERT INTO catalog.shopify_product_connection_commands
          (command_key,product_id,channel_id,connection_id,shop_domain,actor,request_hash,preview_hash,mode,request,source_snapshot,review_evidence,create_spec,created_at,updated_at,next_attempt_at)
          VALUES(${reservation.commandKey}::uuid,${reservation.productId},${reservation.request.channelId},${reservation.source.channel.connectionId},
            ${reservation.source.channel.shopDomain},${reservation.actor},${intentHash({ productId: reservation.productId, request: reservation.request,
              previewHash: reservation.previewHash, source: reservation.source, review: reservation.review, createSpec: reservation.createSpec })},${reservation.previewHash},${reservation.request.mode},
            ${JSON.stringify(reservation.request)}::jsonb,${JSON.stringify(reservation.source)}::jsonb,${JSON.stringify(reservation.review)}::jsonb,${reservation.createSpec === null ? null : JSON.stringify(reservation.createSpec)}::jsonb,
            ${at.toISOString()}::timestamptz,${at.toISOString()}::timestamptz,${at.toISOString()}::timestamptz) RETURNING *`));
        row = created;
        await event(tx, reservation.commandKey, reservation.actor, "command_reserved", { mode: reservation.request.mode, previewHash: reservation.previewHash }, at);
      }
      const at = now();
      if (row.lease_expires_at && new Date(row.lease_expires_at).getTime() > at.getTime()) {
        throw new ShopifyProductConnectionError("SHOPIFY_COMMAND_IN_PROGRESS", "This Shopify command is already running. Retry in a moment.", 409, true);
      }
      const token = newLeaseToken();
      const [claimed] = rows<CommandRow>(await tx.execute(sql`UPDATE catalog.shopify_product_connection_commands
        SET lease_token=${token}::uuid,lease_expires_at=${new Date(at.getTime() + COMMAND_LEASE_MS).toISOString()}::timestamptz,
          resume_attempt_count=resume_attempt_count+${options.runNow === false ? 0 : 1},updated_at=${at.toISOString()}::timestamptz
        WHERE command_key=${reservation.commandKey}::uuid RETURNING *`));
      await event(tx, reservation.commandKey, reservation.actor, "command_claimed", { state: row.state }, at);
      return decode(claimed);
    });
  }

  async function step(command: StoredShopifyConnection, input: {
    state: ShopifyProductConnectionCommand["state"];
    actor: string;
    eventType: string;
    remoteProductId?: string;
    createRequested?: boolean;
    details?: Record<string, unknown>;
    error?: { code: string; message: string; retryable: boolean };
    result?: Record<string, unknown>;
    release?: boolean;
  }): Promise<StoredShopifyConnection> {
    if (!command.leaseToken) throw new ShopifyProductConnectionError("SHOPIFY_COMMAND_STALE_OWNER", "This command no longer has an execution lease.", 409, true);
    return database.transaction(async tx => {
      const at = now();
      const terminal = input.state === "complete" || input.state === "rejected";
      const release = terminal || input.release === true;
      const retryable = (input.error?.retryable ?? !terminal)
        && (!input.error || command.resumeAttemptCount < MAX_AUTOMATIC_ATTEMPTS);
      const retryDelay = input.error ? Math.min(120_000, 2_000 * 2 ** Math.min(command.resumeAttemptCount, 6)) : 0;
      const [updated] = rows<CommandRow>(await tx.execute(sql`UPDATE catalog.shopify_product_connection_commands SET
        state=${input.state},remote_product_id=coalesce(${input.remoteProductId ?? null},remote_product_id),
        create_requested=create_requested OR ${input.createRequested ?? false},
        lease_token=${release ? null : command.leaseToken}::uuid,
        lease_expires_at=${release ? null : new Date(at.getTime() + COMMAND_LEASE_MS).toISOString()}::timestamptz,
        last_error_code=${input.error?.code ?? null},last_error_message=${input.error?.message ?? null},retryable=${retryable},
        next_attempt_at=${new Date(at.getTime() + retryDelay).toISOString()}::timestamptz,
        result=coalesce(${input.result ? JSON.stringify(input.result) : null}::jsonb,result),updated_at=${at.toISOString()}::timestamptz,
        completed_at=${terminal ? at.toISOString() : null}::timestamptz
        WHERE command_key=${command.commandKey}::uuid AND lease_token=${command.leaseToken}::uuid
          AND lease_expires_at>${at.toISOString()}::timestamptz AND state NOT IN ('complete','rejected') RETURNING *`));
      if (!updated) throw new ShopifyProductConnectionError("SHOPIFY_COMMAND_STALE_OWNER", "A newer worker owns this Shopify command. Refresh its status.", 409, true);
      await event(tx, command.commandKey, input.actor, input.eventType,
        { before: command.state, after: input.state, remoteProductId: updated.remote_product_id, ...(input.details ?? {}) }, at);
      return decode(updated);
    });
  }

  return { configuredChannels, credentials, source, find, pending, due, reserve, step };
}

export type ShopifyProductConnectionRepository = ReturnType<typeof createShopifyProductConnectionRepository>;
