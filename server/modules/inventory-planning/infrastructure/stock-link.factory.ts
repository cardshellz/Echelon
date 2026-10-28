import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { StockLinkDestination } from "@shared/types/stock-link";
import { STOCK_LINK_ACTOR } from "../domain/stock-link";
import type { StockLinkPolicyBinding } from "../application/stock-link.ports";
import {
  StockLinkService, createStockLinkRegistry, type StockLinkLogger, type StockLinkSelectionFact, type StockLinkTickStore,
} from "../application/stock-link.service";
import { readPublicationStockSelection } from "./inventory-publication-selection.reader";
import {
  beatStockLinkDestination, claimDueStockLinkChecks, clearStockLinkDestinationPause, countStockLinkRetiresWithoutReplacement,
  deleteClaimedStockLinkChecks, deleteUncarriedStockLinkChecks, haltStockLinkDestination, insertMissingStockLinkChecks,
  listStockLinkDeadLetterWakes, listStockLinkTargets, pauseStockLinkDestination, readStockLinkDestinationHeads,
  readStockLinkRuntimeAuthority, recordStockLinkCheckOutcomes, saveStockLinkCursors, wakeStockLinkChecks,
} from "./stock-link-checks.repository";
import { runShopifyStockLinkCommand } from "./stock-link-shopify-command";

/**
 * Composition of the stock-link engine's tick (channels PR2, PLAN-CH2 v4.1 §7.1, §7.2): the tick's database work on
 * the application pool (stock-link-checks.repository.ts and the listing owner's selection reader), the Shopify command
 * policy (stock-link-shopify-command.ts) and the destinations' bindings (adapter + source, registered by the composition
 * root: server/services/index.ts). Real time, randomness and lease tokens are chosen here, once, and injected.
 */

export type StockLinkPool = Pick<Pool, "connect" | "query">;

/** The tick store over PostgreSQL: each method one read or one short transaction (never across a provider call). */
export function createPostgresStockLinkTickStore(pool: StockLinkPool): StockLinkTickStore {
  return {
    readAuthority: () => readStockLinkRuntimeAuthority(pool),
    listTargets: () => listStockLinkTargets(pool),
    beat: (publicationTargetId, now) => beatStockLinkDestination(pool, publicationTargetId, now),
    saveCursors: (publicationTargetId, update) => saveStockLinkCursors(pool, publicationTargetId, update),
    insertMissingChecks: (publicationTargetId, rows, now) => insertMissingStockLinkChecks(pool, publicationTargetId, rows, now),
    wakeChecks: (publicationTargetId, productVariantIds, now) => wakeStockLinkChecks(pool, publicationTargetId, productVariantIds, now),
    deleteUncarriedChecks: (publicationTargetId, range, carriedVariantIds, now) =>
      deleteUncarriedStockLinkChecks(pool, publicationTargetId, range, carriedVariantIds, now),
    listDeadLetterWakes: (publicationTargetId, after, limit) => listStockLinkDeadLetterWakes(pool, publicationTargetId, after, limit),
    claimDue: (publicationTargetId, input) => claimDueStockLinkChecks(pool, publicationTargetId, input),
    readHeads: publicationTargetId => readStockLinkDestinationHeads(pool, publicationTargetId),
    readSelection: (destination, productId, productVariantIds) => readStockLinkSelection(pool, destination, productId, productVariantIds),
    countRecentRetires: (publicationTargetId, windowStart) =>
      countStockLinkRetiresWithoutReplacement(pool, publicationTargetId, STOCK_LINK_ACTOR, windowStart),
    recordOutcomes: (publicationTargetId, guards, now, decide) => recordStockLinkCheckOutcomes(pool, publicationTargetId, guards, now, decide),
    deleteClaimedChecks: (publicationTargetId, guards) => deleteClaimedStockLinkChecks(pool, publicationTargetId, guards),
    pause: (publicationTargetId, input) => pauseStockLinkDestination(pool, publicationTargetId, input),
    clearPause: (publicationTargetId, codes, now) => clearStockLinkDestinationPause(pool, publicationTargetId, codes, now),
    halt: (publicationTargetId, input) => haltStockLinkDestination(pool, publicationTargetId, input),
  };
}

/**
 * The listing owner's selection of one product's sizes (P-12; readPublicationStockSelection validates the owner's
 * answer and that it names exactly the asked sizes): the action and blocker codes the decision reads.
 */
async function readStockLinkSelection(pool: StockLinkPool, destination: StockLinkDestination, productId: number,
  productVariantIds: readonly number[]): Promise<ReadonlyMap<number, StockLinkSelectionFact>> {
  const selection = await readPublicationStockSelection(pool, {
    destinationKind: destination.destinationKind, channelId: destination.channelId,
    channelConnectionId: destination.channelConnectionId, dropshipStoreConnectionId: destination.dropshipStoreConnectionId,
  }, { productId, productVariantIds });
  return new Map(selection.variants.map(variant => [variant.productVariantId, {
    action: variant.action, blockerCodes: variant.blockers.map(blocker => blocker.code) }]));
}

export interface StockLinkServiceComposition {
  readonly pool: StockLinkPool;
  /** One adapter + source per destination kind and provider (today: Card Shellz's own Shopify stores). */
  readonly bindings: readonly StockLinkPolicyBinding[];
  readonly clock: () => Date;
  readonly monotonicNow: () => number;
  readonly random: () => number;
  readonly newLeaseToken?: () => string;
  readonly logger?: StockLinkLogger;
}

/** The tick's service: the store above, the registry of bindings and the Shopify command policy, one clock for all. */
export function createStockLinkService(composition: StockLinkServiceComposition): StockLinkService {
  const { pool, clock, monotonicNow, random, logger } = composition;
  return new StockLinkService({
    store: createPostgresStockLinkTickStore(pool),
    registry: createStockLinkRegistry(composition.bindings),
    // The only command policy PR2 runs; it refuses any other destination (fatal STOCK_LINK_POLICY_MISSING).
    runCommand: (request, source) => runShopifyStockLinkCommand(pool, request, { source, clock, monotonicNow, random, logger }),
    db: pool,
    clock,
    monotonicNow,
    random,
    newLeaseToken: composition.newLeaseToken ?? randomUUID,
    logger,
  });
}
