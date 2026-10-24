import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../../../db";
import { ebayProductSyncResultSchema, type EbayProductSyncResult } from "@shared/types/ebay-listing-sync";
import { ChannelListingSyncService } from "../../marketplace-listings/application/channel-listing-sync.service";
import { EbayChannelListingSyncAdapter } from "../adapters/ebay/ebay-channel-listing-sync.adapter";
import { EbaySyncSelectionReader } from "./ebay-sync-selection.reader";
import { EBAY_CHANNEL_ID } from "./ebay-api-runtime";
import { ebayListingSyncService, ebayListingSyncRepository, syncActiveListings as updateExisting,
  readEbaySyncDestination, syncFilterSchema, type SyncFilter } from "./ebay-active-listing-sync";
import { admitEbayPublication } from "../ebay-publication-admission.service";
import { readEbayPublicationSource } from "./ebay-listing-push";
import { EbayListingSyncError } from "../ebay-listing-sync.domain";
import type { SyncDestination } from "../../marketplace-listings/domain/channel-sync-batch";

const selection = new EbaySyncSelectionReader(pool, EBAY_CHANNEL_ID);
type ExpectedDestination = { connectionId: number; accountId: string; environment?: "production" | "sandbox"; marketplaceId?: string };
function assertDestination(destination: SyncDestination, expected?: ExpectedDestination) {
  if (expected && (expected.connectionId !== destination.connectionId || expected.accountId !== destination.accountId
    || expected.environment !== undefined && expected.environment !== destination.environment
    || expected.marketplaceId !== undefined && expected.marketplaceId !== destination.marketplaceId))
    throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The channel connection changed. This saved sync cannot target another account.");
}
export async function selectIncludedEbaySyncProducts(productIds?: number[]) {
  const destination = await readEbaySyncDestination();
  const products = (await selection.read(productIds ? { productIds } : null)).filter(row => productIds || row.selection.syncIncluded)
    .map(({ productId, name, sku }) => ({ productId, name, sku }));
  return { destination, products };
}
/** Compatibility facade shared by HTTP, change propagation and durable batches.
 * Recurring stock recovery continues to use existing-listing maintenance only. */
export async function syncChannelListings(filter: SyncFilter | null, actor = "ebay-listing-sync",
  commandKey?: string, expectedDestination?: ExpectedDestination, commandKeys?: ReadonlyMap<number, string>): Promise<EbayProductSyncResult> {
  filter = syncFilterSchema.parse(filter);
  actor = z.string().trim().min(1).max(200).parse(actor);
  if (commandKey !== undefined) z.string().uuid().parse(commandKey);
  if (commandKeys) for (const key of commandKeys.values()) z.string().uuid().parse(key);
  const destination = await readEbaySyncDestination();
  const expected = expectedDestination === undefined ? undefined : z.object({
    connectionId: z.number().int().positive(), accountId: z.string().trim().min(1).max(240),
    environment: z.enum(["production", "sandbox"]).optional(), marketplaceId: z.string().trim().min(1).optional(),
  }).strict().parse(expectedDestination);
  assertDestination(destination, expected);
  // Exact commands must reach their receipt before a changed or unavailable
  // catalog is read. Only a new bulk selection needs current eligibility here.
  const products = filter?.productIds?.length
    ? [...new Set(filter.productIds)].map(productId => ({ productId }))
    : (await selection.read(filter)).filter(row => row.selection.syncIncluded);
  if (commandKey && products.length !== 1 || commandKeys && (commandKey || commandKeys.size !== products.length || products.some(p => !commandKeys.has(p.productId))))
    throw new EbayListingSyncError("EBAY_SYNC_COMMAND_SCOPE_INVALID", "Saved commands must match the selected products exactly.");
  const owner = new ChannelListingSyncService(new EbayChannelListingSyncAdapter({
    receipt: async command => {
      const job = await ebayListingSyncService.getByCommand(command.commandKey, command.channelId, command.actor);
      if (job) {
        if (job.productId !== command.productId || job.operation === "withdraw" || job.identity.connectionId !== destination.connectionId
          || job.identity.accountId !== destination.accountId || job.identity.marketplaceId !== destination.marketplaceId)
          throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This command belongs to another product, operation or account.");
        return job;
      }
      const rejected = (await ebayListingSyncRepository.readCommandStatuses([command.commandKey]))[0];
      if (!rejected) return null;
      if (rejected.actor !== command.actor || rejected.channelId !== command.channelId || rejected.job.productId !== command.productId || rejected.job.operation === "withdraw")
        throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This saved refusal belongs to another requester or product.");
      return rejected.job;
    },
    state: async productId => (await selection.product(productId)).state,
    update: command => updateExisting({ productIds: [command.productId] }, command.actor, command.commandKey,
      { connectionId: destination.connectionId, accountId: destination.accountId,
        environment: z.enum(["production", "sandbox"]).parse(destination.environment), marketplaceId: destination.marketplaceId ?? undefined },
      undefined, { inspectRetainedIdentity: true }),
    publish: ({ productId, actor, commandKey }) => admitEbayPublication({ productId, actor, commandKey }, {
      channelId: EBAY_CHANNEL_ID, jobs: ebayListingSyncService,
      readSource: async id => {
        const source = await readEbayPublicationSource(id);
        assertDestination(await readEbaySyncDestination(), destination);
        if (source.connectionId !== destination.connectionId || source.accountId !== destination.accountId || source.marketplaceId !== destination.marketplaceId)
          throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The channel account changed while preparing this request. Review the connection before starting another sync.");
        return source;
      },
    }),
    block: (command, blocker) => ebayListingSyncService.recordAdmissionFailure({ ...command, ...blocker, variantIds: [], operation: "sync" }),
  }));
  const result = ebayProductSyncResultSchema.parse({ synced: 0, priceChanges: 0, qtyChanges: 0, policyChanges: 0, errors: 0, details: [] });
  for (const product of products) {
    const key = commandKeys?.get(product.productId) ?? commandKey ?? randomUUID();
    try {
      const receipt = await owner.request({ channelId: EBAY_CHANNEL_ID, productId: product.productId, actor, commandKey: key });
      for (const field of ["synced", "priceChanges", "qtyChanges", "policyChanges", "errors", "pending"] as const) result[field] += receipt[field];
      result.jobs.push(...receipt.jobs); result.details.push(...receipt.details);
    } catch (error) {
      // No refusal is persisted for an unconfirmed read/commit. The durable batch
      // keeps this exact key outstanding while unrelated products can progress.
      const code = error instanceof EbayListingSyncError ? error.code : "EBAY_SYNC_ADMISSION_UNSAVED";
      console.error(JSON.stringify({ event: "channel_sync_admission_unconfirmed", productId: product.productId, commandKey: key, code }));
      result.errors++;
      result.details.push({ success: false, productId: product.productId, code,
        error: error instanceof EbayListingSyncError ? error.message : "This sync request could not be confirmed. Retry the same saved request to check its result." });
    }
  }
  return ebayProductSyncResultSchema.parse(result);
}
