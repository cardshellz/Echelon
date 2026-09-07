import { and, eq, ne, or } from "drizzle-orm";
import { z } from "zod";
import { channelConnections, channelFeeds, channelListings, channels } from "@shared/schema";
import { readCatalogInventoryIdentity } from "../catalog";
import { assertLegacyChannelIdentityRepairAllowed, LegacyChannelIdentityAuthorityError } from "../inventory-planning/application/inventory-publication-identity-guard";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import { createDrizzleFinancialCommandRepository, readSuccessfulFinancialCommand } from "../../platform/commands/command-results.repository";
import { runTransactionalFinancialCommand, type FinancialCommandFailureDisposition } from "../../platform/commands/transactional-command.service";
import { ChannelIdentityService } from "./channel-identity.service";
import { ChannelIdentityError, internalIdentitySchema } from "./channel-identity.domain";
import { ShopifyIdentityReader, type ShopifyVariantIdentity } from "./adapters/shopify-identity.reader";
import { feedIdentitySnapshot, identityFingerprint, listingIdentitySnapshot, planChannelIdentityRepair } from "./channel-identity-repair.domain";

type Database = typeof import("../../db").db;
type Query = Pick<Database, "select" | "insert" | "update" | "transaction">;
const commandSchema = z.object({ channelId: internalIdentitySchema, feedId: internalIdentitySchema,
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/), actor: z.string().trim().min(1).max(200), idempotencyKey: z.string().trim().min(1).max(200) }).strict();
const feedSnapshotSchema = z.object({ id: internalIdentitySchema, channelId: internalIdentitySchema, productVariantId: internalIdentitySchema,
  channelVariantId: z.string(), channelProductId: z.string().nullable(), channelSku: z.string().nullable(), channelInventoryItemId: z.string().nullable(),
  isActive: z.number().int().min(0).max(1), quarantinedAt: z.string().datetime().nullable(), quarantineReason: z.string().nullable(), updatedAt: z.string().datetime() });
const listingSnapshotSchema = z.object({ id: internalIdentitySchema, channelId: internalIdentitySchema, productVariantId: internalIdentitySchema,
  externalVariantId: z.string().nullable(), externalProductId: z.string().nullable(), externalSku: z.string().nullable(),
  syncStatus: z.string().nullable(), syncError: z.string().nullable(), updatedAt: z.string().datetime() }).nullable();
const receiptSchema = z.object({ action: z.enum(["repair", "disable", "unchanged"]),
  scope: z.object({ channelId: internalIdentitySchema, connectionId: internalIdentitySchema, externalAccountId: z.string() }),
  feedId: internalIdentitySchema, before: feedSnapshotSchema, after: feedSnapshotSchema,
  listingBefore: listingSnapshotSchema, listingAfter: listingSnapshotSchema });

function classify(error: unknown): FinancialCommandFailureDisposition {
  const known = error instanceof ChannelIdentityError;
  const code = known ? error.code : "CHANNEL_IDENTITY_REPAIR_FAILED";
  const message = known ? error.message : "Mapping repair failed; no mapping changes were committed";
  return known && error.failureClass === "permanent"
    ? { kind: "rejected", httpStatus: 409, body: { code, error: message }, errorCode: code, errorMessage: message }
    : { kind: "retryable", errorCode: code, errorMessage: message };
}

/** No provider writes or inventory writes. Existing command/audit owners supply durability. */
export class ChannelIdentityRepairService {
  constructor(private readonly db: Database, private readonly reader = new ShopifyIdentityReader(), private readonly clock: () => Date = () => new Date()) {}

  private async plan(client: Query, channelId: number, feedId: number, lock = false) {
    if (lock) {
      await client.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).for("update");
      await client.select({ id: channelConnections.id }).from(channelConnections).where(eq(channelConnections.channelId, channelId)).for("share");
    }
    const connection = await new ChannelIdentityService(client).shopifyConnection(channelId);
    let feedQuery = client.select().from(channelFeeds).where(and(eq(channelFeeds.id, feedId), eq(channelFeeds.channelId, channelId))).limit(1).$dynamic();
    if (lock) feedQuery = feedQuery.for("update");
    const [feed] = await feedQuery;
    if (!feed) throw new ChannelIdentityError("CHANNEL_FEED_NOT_FOUND", "Feed does not belong to the selected channel");
    let listingQuery = client.select().from(channelListings).where(and(eq(channelListings.channelId, channelId), eq(channelListings.productVariantId, feed.productVariantId))).limit(1).$dynamic();
    if (lock) listingQuery = listingQuery.for("update");
    const [listing] = await listingQuery;
    const catalog = await readCatalogInventoryIdentity(client, feed.productVariantId, lock);
    let evidence: ShopifyVariantIdentity | null = null;
    let readErrorCode: string | undefined;
    try { evidence = await this.reader.variant(connection, feed.channelVariantId); }
    catch (error) {
      if (error instanceof ChannelIdentityError) {
        if (lock && error.failureClass === "transient") throw error;
        readErrorCode = error.code;
      }
      else if (error instanceof z.ZodError) readErrorCode = "DESTINATION_ID_INVALID";
      else throw error;
    }
    return planChannelIdentityRepair({ scope: { channelId, connectionId: connection.id, externalAccountId: connection.shopDomain }, feed, listing, catalog, evidence, readErrorCode });
  }

  async preview(channelId: number, feedIds: number[]) {
    internalIdentitySchema.parse(channelId);
    z.array(internalIdentitySchema).min(1).max(25).refine((ids) => new Set(ids).size === ids.length).parse(feedIds);
    const plans = [];
    for (const feedId of feedIds) plans.push(await this.plan(this.db, channelId, feedId));
    return { generatedAt: this.clock().toISOString(), channelId, plans };
  }

  async apply(raw: z.input<typeof commandSchema>) {
    const input = commandSchema.parse(raw);
    return runTransactionalFinancialCommand({ repository: createDrizzleFinancialCommandRepository(this.db),
      descriptor: { actorType: "user", actorId: input.actor, method: "POST", routeTemplate: "/api/channels/:channelId/identity-repair/apply",
        resourceKey: `${input.channelId}:${input.feedId}`, idempotencyKey: input.idempotencyKey,
        requestHash: identityFingerprint({ channelId: input.channelId, feedId: input.feedId, expectedHash: input.expectedHash }), commandName: "channel_identity.repair", contractVersion: 1 },
      classifyFailure: classify,
      work: async (tx) => {
        try { await assertLegacyChannelIdentityRepairAllowed(tx, input.channelId); }
        catch (error) {
          if (!(error instanceof LegacyChannelIdentityAuthorityError)) throw error;
          throw new ChannelIdentityError("CHANNEL_IDENTITY_AUTHORITY_BLOCKED", "Legacy repair is blocked by publication authority; use the canonical target revision workflow");
        }
        const plan = await this.plan(tx, input.channelId, input.feedId, true);
        if (plan.expectedHash !== input.expectedHash) throw new ChannelIdentityError("CHANNEL_IDENTITY_PREVIEW_STALE", "Mapping or provider evidence changed; refresh preview");
        if (plan.action === "blocked") throw new ChannelIdentityError(plan.code, "This mapping requires review; no automatic repair is supported");
        const timestamp = this.clock();
        let after = plan.before;
        let listingAfter = plan.listingBefore;
        if (plan.action === "repair" && plan.evidence) {
          const evidence = plan.evidence;
          const conflicts = await tx.select({ id: channelFeeds.id }).from(channelFeeds).where(and(
            eq(channelFeeds.channelId, input.channelId), ne(channelFeeds.id, input.feedId),
            or(eq(channelFeeds.channelVariantId, evidence.id), eq(channelFeeds.channelInventoryItemId, evidence.inventory_item_id)),
          )).limit(1).for("update");
          if (conflicts.length) throw new ChannelIdentityError("CHANNEL_IDENTITY_CONFLICT", "Another internal variant already owns this destination identity");
          const [saved] = await tx.update(channelFeeds).set({ channelProductId: evidence.product_id,
            channelInventoryItemId: evidence.inventory_item_id, channelSku: evidence.sku, updatedAt: timestamp,
          }).where(eq(channelFeeds.id, input.feedId)).returning();
          after = feedIdentitySnapshot(saved);
          const values = { channelId: input.channelId, productVariantId: plan.productVariantId, externalProductId: evidence.product_id,
            externalVariantId: evidence.id, externalSku: evidence.sku, syncStatus: "pending", syncError: null, updatedAt: timestamp };
          const [savedListing] = await tx.insert(channelListings).values(values).onConflictDoUpdate({
            target: [channelListings.channelId, channelListings.productVariantId], set: values,
          }).returning();
          listingAfter = listingIdentitySnapshot(savedListing);
        } else if (plan.action === "disable") {
          const [saved] = await tx.update(channelFeeds).set({ isActive: 0, quarantinedAt: timestamp,
            quarantineReason: plan.code, updatedAt: timestamp }).where(eq(channelFeeds.id, input.feedId)).returning();
          after = feedIdentitySnapshot(saved);
          const [savedListing] = await tx.update(channelListings).set({ syncStatus: "requires_review", syncError: plan.code, updatedAt: timestamp })
            .where(and(eq(channelListings.channelId, input.channelId), eq(channelListings.productVariantId, plan.productVariantId))).returning();
          listingAfter = listingIdentitySnapshot(savedListing);
        }
        const body = { action: plan.action, scope: plan.scope, feedId: input.feedId, before: plan.before, after, listingBefore: plan.listingBefore, listingAfter };
        if (plan.action !== "unchanged") await persistAuditEvent(tx, { actor: input.actor, action: "channel_identity.repair",
          target: `channel_feed:${input.feedId}`, changes: { before: { feed: plan.before, listing: plan.listingBefore }, after: { feed: after, listing: listingAfter } },
          context: { scope: plan.scope, expectedHash: input.expectedHash, code: plan.code } }, { timestamp });
        return { httpStatus: 200, body, resultType: "channel_feed", resultId: input.feedId };
      },
    });
  }

  async recover(raw: { channelId: number; applyCommandId: number; actor: string; idempotencyKey: string }) {
    const input = z.object({ channelId: internalIdentitySchema, applyCommandId: internalIdentitySchema,
      actor: z.string().trim().min(1).max(200), idempotencyKey: z.string().trim().min(1).max(200) }).strict().parse(raw);
    return runTransactionalFinancialCommand({ repository: createDrizzleFinancialCommandRepository(this.db),
      descriptor: { actorType: "user", actorId: input.actor, method: "POST", routeTemplate: "/api/channels/:channelId/identity-repair/recover",
        resourceKey: `${input.channelId}:${input.applyCommandId}`, idempotencyKey: input.idempotencyKey,
        requestHash: identityFingerprint({ channelId: input.channelId, applyCommandId: input.applyCommandId }), commandName: "channel_identity.recover", contractVersion: 1 },
      classifyFailure: classify,
      work: async (tx) => {
        const parsed = receiptSchema.safeParse(await readSuccessfulFinancialCommand(tx, input.applyCommandId, "channel_identity.repair"));
        if (!parsed.success || parsed.data.scope.channelId !== input.channelId || parsed.data.action === "unchanged") {
          throw new ChannelIdentityError("CHANNEL_REPAIR_RECEIPT_REQUIRED", "A retained successful repair receipt for this channel is required");
        }
        const receipt = parsed.data;
        try { await assertLegacyChannelIdentityRepairAllowed(tx, input.channelId); }
        catch (error) {
          if (!(error instanceof LegacyChannelIdentityAuthorityError)) throw error;
          throw new ChannelIdentityError("CHANNEL_IDENTITY_AUTHORITY_BLOCKED", "Canonical publication ownership prevents legacy mapping recovery");
        }
        await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, input.channelId)).for("update");
        await tx.select({ id: channelConnections.id }).from(channelConnections).where(eq(channelConnections.channelId, input.channelId)).for("share");
        const connection = await new ChannelIdentityService(tx).shopifyConnection(input.channelId);
        if (connection.id !== receipt.scope.connectionId || connection.shopDomain !== receipt.scope.externalAccountId) {
          throw new ChannelIdentityError("CHANNEL_RECOVERY_ACCOUNT_CHANGED", "The destination account changed after repair; recovery requires review");
        }
        const [current] = await tx.select().from(channelFeeds).where(and(eq(channelFeeds.id, receipt.feedId), eq(channelFeeds.channelId, input.channelId))).for("update");
        const [listing] = await tx.select().from(channelListings).where(and(eq(channelListings.channelId, input.channelId), eq(channelListings.productVariantId, receipt.before.productVariantId))).for("update");
        if (!current || identityFingerprint(feedIdentitySnapshot(current)) !== identityFingerprint(receipt.after)
          || identityFingerprint(listingIdentitySnapshot(listing)) !== identityFingerprint(receipt.listingAfter)) {
          throw new ChannelIdentityError("CHANNEL_RECOVERY_STALE", "Mapping changed after repair; recovery will not overwrite intervening edits");
        }
        const timestamp = this.clock();
        const [saved] = await tx.update(channelFeeds).set({ channelVariantId: receipt.before.channelVariantId,
          channelProductId: receipt.before.channelProductId, channelInventoryItemId: receipt.before.channelInventoryItemId,
          channelSku: receipt.before.channelSku, isActive: 0, quarantinedAt: timestamp,
          quarantineReason: "IDENTITY_REPAIR_RECOVERY_REVIEW", updatedAt: timestamp }).where(eq(channelFeeds.id, receipt.feedId)).returning();
        let savedListing = listing;
        if (listing) {
          [savedListing] = await tx.update(channelListings).set({
            ...(receipt.listingBefore ? { externalVariantId: receipt.listingBefore.externalVariantId,
              externalProductId: receipt.listingBefore.externalProductId, externalSku: receipt.listingBefore.externalSku } : {}),
            syncStatus: "requires_review", syncError: "IDENTITY_REPAIR_RECOVERY_REVIEW", updatedAt: timestamp,
          }).where(eq(channelListings.id, listing.id)).returning();
        }
        const body = { feedId: receipt.feedId, applyCommandId: input.applyCommandId, status: "recovered_disabled",
          after: feedIdentitySnapshot(saved), listingAfter: listingIdentitySnapshot(savedListing) };
        await persistAuditEvent(tx, { actor: input.actor, action: "channel_identity.recover", target: `channel_feed:${receipt.feedId}`,
          changes: { before: { feed: receipt.after, listing: receipt.listingAfter }, after: body },
          context: { applyCommandId: input.applyCommandId, scope: receipt.scope } }, { timestamp });
        return { httpStatus: 200, body, resultType: "channel_feed", resultId: receipt.feedId };
      },
    });
  }
}
