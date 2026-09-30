import { z } from "zod";
import {
  listingAccountSchema,
  listingCatalogPageSchema,
  listingDraftSchema,
  listingPriceRuleSchema,
  listingReviewSchema,
  listingTaxonomySchema,
  saveListingDraftSchema,
  submitListingReviewSchema,
  type ListingAccount,
  type ListingCatalogItem,
  type ListingDraft,
  type ListingOperation,
  type ListingPriceRule,
  type ListingReview,
  type ListingTaxonomy,
} from "@shared/types/channel-listing-publication";
import type { ChannelCatalogService } from "../../channels/channel-catalog.service";
import { ChannelProviderError } from "../../channels/channel-provider.error";
import type {
  ListingPublicationProvider,
  PreparedListingItem,
} from "./listing-publication-provider.port";
import { ListingSubmissionError } from "./listing-publication-provider.port";
import type { ListingPublicationStore } from "./listing-publication-store.port";
import type { ListingSetupZeroIntent } from "../../inventory-planning/application/listing-setup-zero-intent";
import {
  ListingPublicationError,
  listingAccountKey,
  listingHash,
  listingIssue,
  listingOperationView,
  preparedListingItemSchema,
  type ListingProgress,
  type ListingSnapshot,
  type StoredListingOperation,
} from "../domain/listing-publication";

export interface ListingPublicationCatalog {
  catalog(
    channelId: number,
    query: unknown,
  ): Promise<z.infer<typeof listingCatalogPageSchema>>;
  pricingRule(channelId: number): Promise<ListingPriceRule | null>;
  savePricingRule(
    channelId: number,
    input: unknown,
    actor: string,
    now: Date,
  ): Promise<ListingPriceRule>;
}
export interface ListingPublicationInventory {
  inspect(
    account: ListingAccount,
    items: readonly ListingCatalogItem[],
  ): Promise<ListingReview["inventory"]>;
  /** The inventory owner must hold quantity admission for the complete zero-stock request. */
  submitZero(
    account: ListingAccount,
    operationId: string,
    items: PreparedListingItem[],
    reviewedInventory: ListingReview["inventory"],
    submit: (
      admission: Readonly<ListingSetupZeroIntent>,
    ) => Promise<{ submissionId: string }>,
  ): Promise<{ submissionId: string }>;
}
export interface ListingPublicationDependencies {
  store: ListingPublicationStore;
  catalog: ListingPublicationCatalog;
  provider(channelId: number): Promise<ListingPublicationProvider>;
  identities(channelId: number): Promise<Pick<ChannelCatalogService, "link">>;
  inventory: ListingPublicationInventory;
  now(): Date;
  uuid(): string;
}
const REVIEW_LIFETIME_MS = 15 * 60_000;
const FEED_POLL_INTERVAL_MS = 15 * 60_000;
const actorSchema = z.string().trim().min(1).max(200);

/** Provider-neutral orchestration. All external effects follow a saved exact review. */
export class ListingPublicationService {
  constructor(private readonly dependencies: ListingPublicationDependencies) {}
  async workspace(channelId: number) {
    await this.provider(channelId);
    const [draft, operations, pricingRule] = await Promise.all([
      this.dependencies.store.draft(channelId),
      this.dependencies.store.operations(channelId),
      this.dependencies.catalog.pricingRule(channelId),
    ]);
    return {
      draft,
      operations: operations.map(listingOperationView),
      pricingRule,
    };
  }
  async catalog(channelId: number, query: unknown) {
    await this.provider(channelId);
    return listingCatalogPageSchema.parse(
      await this.dependencies.catalog.catalog(channelId, query),
    );
  }
  async saveDraft(
    channelId: number,
    input: unknown,
    actor: string,
  ): Promise<ListingDraft> {
    const command = saveListingDraftSchema.parse(input);
    const provider = await this.provider(channelId);
    const account = listingAccountSchema.parse(
      await provider.account(channelId),
    );
    return this.dependencies.store.saveDraft(
      account,
      listingDraftSchema.parse({
        channelId,
        revision: command.expectedRevision,
        items: command.items,
        updatedAt: null,
      }),
      actorSchema.parse(actor),
      this.now(),
    );
  }
  async savePricing(
    channelId: number,
    input: unknown,
    actor: string,
  ): Promise<ListingPriceRule> {
    await this.provider(channelId);
    return this.dependencies.catalog.savePricingRule(
      channelId,
      listingPriceRuleSchema.parse(input),
      actorSchema.parse(actor),
      this.now(),
    );
  }
  async taxonomy(channelId: number): Promise<ListingTaxonomy> {
    const provider = await this.provider(channelId);
    return listingTaxonomySchema.parse(
      await provider.taxonomy(await provider.account(channelId)),
    );
  }
  async requirements(channelId: number, input: unknown) {
    const query = z
      .object({
        productType: z.string().trim().max(200).default(""),
        method: z.enum(["create", "match"]),
      })
      .superRefine((value, context) => {
        if (value.method === "create" && !value.productType)
          context.addIssue({
            code: "custom",
            path: ["productType"],
            message: "Select a product type for new item setup",
          });
      })
      .parse(input);
    const provider = await this.provider(channelId);
    return provider.requirements(
      await provider.account(channelId),
      query.productType,
      query.method,
    );
  }
  async review(
    channelId: number,
    input: unknown,
    actor: string,
  ): Promise<ListingReview> {
    const command = z
      .object({ expectedRevision: z.number().int().positive() })
      .strict()
      .parse(input);
    const draft = await this.dependencies.store.draft(channelId);
    if (draft.revision !== command.expectedRevision) stale();
    if (draft.items.length === 0)
      throw new ListingPublicationError(
        "LISTING_SELECTION_EMPTY",
        "Select at least one variant before reviewing",
        400,
      );
    const provider = await this.provider(channelId);
    const account = listingAccountSchema.parse(
      await provider.account(channelId),
    );
    const catalog = await this.catalogForIds(
      channelId,
      draft.items.map((item) => item.variantId),
    );
    const prepared: PreparedListingItem[] = [];
    const items: ListingReview["items"] = [];
    for (const item of draft.items) {
      const source = catalog.find(
        (candidate) => candidate.variantId === item.variantId,
      );
      if (!source)
        throw new ListingPublicationError(
          "LISTING_VARIANT_MISSING",
          "A selected catalog variant no longer exists",
        );
      const price = item.priceOverrideCents ?? source.priceCents;
      const issues = [];
      if (!source.eligible || !source.sku.trim())
        issues.push(
          listingIssue(
            "LISTING_VARIANT_UNAVAILABLE",
            "This variant is not eligible for marketplace fulfillment",
          ),
        );
      if (source.alreadyLinked)
        issues.push(
          listingIssue(
            "LISTING_ALREADY_EXISTS",
            "This SKU already has a channel listing. Use Existing Walmart items instead.",
          ),
        );
      if (price === null || price <= 0 || !Number.isSafeInteger(price))
        issues.push(
          listingIssue(
            "LISTING_PRICE_REQUIRED",
            "Set a positive selling price",
            "priceOverrideCents",
          ),
        );
      let candidate: PreparedListingItem | null = null;
      if (issues.length === 0 && price !== null) {
        candidate = preparedListingItemSchema.parse(
          await provider.prepare(account, {
            catalog: source,
            draft: item,
            priceCents: price,
          }),
        );
        if (
          candidate.variantId !== source.variantId ||
          candidate.sku !== source.sku
        )
          throw new ListingPublicationError(
            "LISTING_PROVIDER_IDENTITY_CHANGED",
            "Listing preparation returned a different variant identity",
          );
        issues.push(...candidate.issues);
        prepared.push(candidate);
      }
      items.push({
        variantId: item.variantId,
        productId: source.productId,
        sku: source.sku,
        title: item.title ?? source.title,
        unitLabel: source.unitLabel,
        method: item.method,
        productType: item.productType,
        priceCents: price,
        priceSource:
          item.priceOverrideCents !== null
            ? "item_override"
            : source.priceSource,
        issues,
        schemaVersion: candidate?.schemaVersion ?? null,
      });
    }
    const inventory = await this.dependencies.inventory.inspect(
      account,
      catalog,
    );
    const issues = inventory.ready
      ? []
      : [listingIssue("LISTING_STOCK_SETUP_REQUIRED", inventory.message)];
    if (new Set(items.map((item) => item.sku)).size !== items.length)
      issues.push(
        listingIssue(
          "LISTING_DUPLICATE_SKU",
          "Selected variants must have distinct seller SKUs",
        ),
      );
    const now = this.now();
    const evidence = { account, draft, catalog, prepared, inventory };
    const review = listingReviewSchema.parse({
      id: this.uuid(),
      draftRevision: draft.revision,
      reviewHash: listingHash(evidence),
      account,
      items,
      issues,
      canSubmit:
        issues.length === 0 &&
        items.every((item) => item.issues.length === 0) &&
        prepared.length === draft.items.length,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REVIEW_LIFETIME_MS).toISOString(),
      inventory,
    });
    await this.dependencies.store.saveReview(
      { review, account, draft, catalog, prepared },
      actorSchema.parse(actor),
      now,
    );
    return review;
  }
  async submit(
    channelId: number,
    input: unknown,
    actor: string,
  ): Promise<ListingOperation> {
    const command = submitListingReviewSchema.parse(input);
    const requestHash = listingHash({
      reviewId: command.reviewId,
      reviewHash: command.reviewHash,
    });
    // A lost HTTP acknowledgement is resolved before any current-state or provider call.
    const repeated = await this.dependencies.store.replay(
      channelId,
      command.commandKey,
      requestHash,
    );
    if (repeated) return listingOperationView(repeated);
    const snapshot = await this.dependencies.store.review(
      channelId,
      command.reviewId,
    );
    if (
      snapshot.review.reviewHash !== command.reviewHash ||
      new Date(snapshot.review.expiresAt) <= this.now()
    )
      stale();
    if (!snapshot.review.canSubmit)
      throw new ListingPublicationError(
        "LISTING_REVIEW_BLOCKED",
        "Resolve the review blockers before publishing",
      );
    await this.assertCurrent(
      snapshot,
      snapshot.catalog.map((item) => item.variantId),
    );
    const batches: ListingProgress["batches"] = [];
    for (const item of snapshot.prepared) {
      const key = listingHash([item.feedType, item.schemaVersion]);
      let batch = batches.find((candidate) => candidate.key === key);
      if (!batch) {
        batch = {
          key,
          correlationId: this.uuid(),
          variantIds: [],
          submissionId: null,
          state: "queued",
        };
        batches.push(batch);
      }
      batch.variantIds.push(item.variantId);
    }
    const progress: ListingProgress = {
      batches,
      error: null,
      items: snapshot.review.items.map((item) => ({
        variantId: item.variantId,
        sku: item.sku,
        priceCents: z.number().int().positive().parse(item.priceCents),
        state: "queued",
        externalProductId: null,
        error: null,
        stockState: "waiting_for_item",
        canRetry: false,
      })),
    };
    return listingOperationView(
      await this.dependencies.store.createOperation({
        id: this.uuid(),
        snapshot,
        progress,
        commandKey: command.commandKey,
        requestHash,
        actor: actorSchema.parse(actor),
        now: this.now(),
      }),
    );
  }
  async operations(channelId: number) {
    await this.provider(channelId);
    return (await this.dependencies.store.operations(channelId)).map(
      listingOperationView,
    );
  }
  async reconcile(channelId: number, id: string, actor: string) {
    await this.provider(channelId);
    return listingOperationView(
      await this.dependencies.store.requestReconciliation(
        channelId,
        z.string().uuid().parse(id),
        actorSchema.parse(actor),
        this.now(),
      ),
    );
  }
  async retryItems(channelId: number, id: string) {
    await this.provider(channelId);
    const operation = await this.dependencies.store.operation(
      channelId,
      z.string().uuid().parse(id),
    );
    const retryIds = new Set(
      operation.progress.items
        .filter((item) => item.canRetry && item.state === "needs_attention")
        .map((item) => item.variantId),
    );
    return {
      items: operation.snapshot.draft.items.filter((item) =>
        retryIds.has(item.variantId),
      ),
    };
  }

  async processDue(limit = 5): Promise<{ processed: number; failed: number }> {
    z.number().int().min(1).max(100).parse(limit);
    let processed = 0,
      failed = 0;
    for (let index = 0; index < limit; index++) {
      const operation = await this.dependencies.store.claim(
        this.now(),
        this.uuid(),
      );
      if (!operation) break;
      try {
        await this.process(operation);
        processed++;
      } catch (error) {
        failed++;
        console.error(
          JSON.stringify({
            operation: "listing_publication_worker",
            id: operation.id,
            code: safeCode(error),
          }),
        );
      }
    }
    return { processed, failed };
  }
  private async process(initial: StoredListingOperation): Promise<void> {
    let operation = initial;
    let progress = structuredClone(operation.progress);
    const persist = async (releaseLease = false) => {
      operation = await this.dependencies.store.saveProgress(
        operation,
        progress,
        {
          now: this.now(),
          nextAttemptAt: new Date(this.now().getTime() + FEED_POLL_INTERVAL_MS),
          releaseLease,
          actor: "listing-publication-worker",
        },
      );
    };
    try {
      const provider = await this.provider(operation.channelId);
      const currentAccount = await provider.account(operation.channelId);
      // Credential rotation may refresh readback of an already-submitted feed.
      // Unsent batches still require the exact reviewed revision below.
      try {
        assertAccount(operation.snapshot.account, currentAccount, false);
      } catch (error) {
        // A different account or node invalidates every unsent batch's consent.
        // Keep submitted receipts intact; they still need owner reconciliation.
        for (const batch of progress.batches)
          if (batch.state === "queued")
            requireNewBatchReview(progress, batch, error);
        throw error;
      }
      for (let index = 0; index < progress.batches.length; index++) {
        const batch = progress.batches[index];
        if (batch.state === "queued") {
          try {
            await this.assertCurrent(operation.snapshot, batch.variantIds);
          } catch (error) {
            if (!invalidatesReviewedBatch(error)) throw error;
            // Only definitive preflight evidence invalidates this unsent batch.
            // Another feed family may still have an unchanged reviewed selection.
            requireNewBatchReview(progress, batch, error);
            await persist();
            continue;
          }
          const items = operation.snapshot.prepared.filter((item) =>
            batch.variantIds.includes(item.variantId),
          );
          // Journal before entering the quantity owner and before any provider effect.
          batch.state = "submitting";
          await persist();
          let providerEntered = false;
          try {
            const submitted = await this.dependencies.inventory.submitZero(
              currentAccount,
              // Each feed family has its own immutable admission command. The
              // parent operation durably retains this correlation identity.
              batch.correlationId,
              items,
              operation.snapshot.review.inventory,
              (admission) => {
                providerEntered = true;
                return provider.submit(currentAccount, {
                  operationId: batch.correlationId,
                  correlationId: batch.correlationId,
                  items,
                  zeroStockAdmission: admission,
                  beforeSubmit: () =>
                    this.dependencies.store.renewLease(operation, this.now()),
                });
              },
            );
            batch.submissionId = z
              .string()
              .min(1)
              .max(1_000)
              .parse(submitted.submissionId);
            batch.state = "processing";
            for (const item of progress.items)
              if (batch.variantIds.includes(item.variantId))
                item.state = "processing";
            await persist();
          } catch (error) {
            const noEffect =
              !providerEntered ||
              (error instanceof ListingSubmissionError &&
                error.effect !== "uncertain");
            batch.state = !noEffect ? "needs_reconciliation" : "processed";
            progress.error = safeMessage(error);
            for (const item of progress.items)
              if (batch.variantIds.includes(item.variantId)) {
                item.state = !noEffect
                  ? "needs_reconciliation"
                  : "needs_attention";
                item.canRetry = noEffect;
                item.error = !noEffect
                  ? "Submission needs reconciliation before another write."
                  : safeMessage(error);
              }
            await persist(true);
            return;
          }
        }
        if (batch.submissionId && batch.state !== "processed") {
          const observation = await provider.status(
            currentAccount,
            batch.submissionId,
          );
          const observedSkus = new Set<string>();
          for (const result of observation.items) {
            if (observedSkus.has(result.sku))
              throw new ListingPublicationError(
                "LISTING_PROVIDER_DUPLICATE_RESULT",
                "Walmart returned duplicate item outcomes",
              );
            observedSkus.add(result.sku);
            const item = progress.items.find(
              (item) =>
                batch.variantIds.includes(item.variantId) &&
                item.sku === result.sku,
            );
            if (!item)
              throw new ListingPublicationError(
                "LISTING_PROVIDER_SCOPE_CHANGED",
                "Provider results contain an item outside the reviewed selection",
              );
            if (item.state === "verified") continue;
            item.state = result.state;
            item.externalProductId = result.externalProductId;
            item.canRetry =
              observation.state !== "processing" &&
              result.state === "needs_attention" &&
              result.retryable === true;
            item.error = result.issues.length
              ? result.issues
                  .map((issue) => issue.message)
                  .join("; ")
                  .slice(0, 2000)
              : null;
          }
          if (observation.state !== "processing") {
            batch.state = observation.items.some(
              (result) => result.state === "processing",
            )
              ? "processing"
              : "processed";
            for (const item of progress.items)
              if (
                batch.variantIds.includes(item.variantId) &&
                !observedSkus.has(item.sku) &&
                item.state !== "verified"
              ) {
                batch.state = "processing";
                item.state = "needs_attention";
                item.canRetry = false;
                item.error =
                  "Provider completed the feed without a result for this SKU.";
              }
          }
          await persist();
        }
        for (const item of progress.items.filter(
          (item) =>
            batch.variantIds.includes(item.variantId) &&
            (item.state === "accepted" ||
              item.state === "needs_reconciliation"),
        )) {
          // Observation and mapping are independently replayable after partial owner commits.
          let observed: Awaited<
            ReturnType<ListingPublicationProvider["observe"]>
          >;
          try {
            observed = await provider.observe(currentAccount, item.sku);
          } catch (error) {
            if (
              !(error instanceof ChannelProviderError) ||
              error.status !== 404
            )
              throw error;
            item.error = "Waiting for Walmart to expose the submitted item.";
            await persist();
            continue;
          }
          if (
            observed.item.sku !== item.sku ||
            observed.priceCents !== item.priceCents
          ) {
            item.error =
              "The observed SKU or price does not yet match the submitted item.";
            await persist();
            continue;
          }
          if (
            observed.item.lifecycleStatus.toUpperCase() !== "ACTIVE" ||
            !["PUBLISHED", "UNPUBLISHED"].includes(
              observed.item.publishedStatus.toUpperCase(),
            )
          ) {
            item.error = "Waiting for Walmart to finish item activation.";
            await persist();
            continue;
          }
          if (!observed.item.externalProductId) {
            item.error = "Waiting for Walmart's product identity.";
            await persist();
            continue;
          }
          if (
            item.externalProductId &&
            item.externalProductId !== observed.item.externalProductId
          ) {
            item.error =
              "The observed Walmart product differs from the accepted feed identity. Reconcile this SKU before linking.";
            item.state = "needs_reconciliation";
            item.canRetry = false;
            batch.state = "needs_reconciliation";
            await persist();
            continue;
          }
          if (!batch.submissionId) {
            // An identical SKU/price alone cannot prove which request created it.
            // Keep uncertain submissions fenced until a correlated receipt exists.
            item.error =
              "The SKU exists, but its submission receipt is missing. Reconciliation is required before linking or retrying.";
            await persist();
            continue;
          }
          await (
            await this.dependencies.identities(operation.channelId)
          ).link(
            operation.channelId,
            {
              mappings: [
                {
                  sku: item.sku,
                  productVariantId: item.variantId,
                  expectedExternalProductId: observed.item.externalProductId,
                },
              ],
            },
            "listing-publication-worker",
          );
          item.externalProductId = observed.item.externalProductId;
          item.state = "verified";
          item.error = null;
          item.stockState = "setup_required";
          await persist();
        }
        if (
          batch.state === "needs_reconciliation" &&
          batch.variantIds.every((id) =>
            progress.items.some(
              (item) => item.variantId === id && item.state === "verified",
            ),
          )
        )
          batch.state = "processed";
        if (batch.state === "needs_reconciliation") break;
      }
      progress.error = null;
      await persist(true);
    } catch (error) {
      if (
        error instanceof ListingPublicationError &&
        error.code === "LISTING_LEASE_LOST"
      )
        throw error;
      progress.error = safeMessage(error);
      // Read, poll, observation and linking failures do not invalidate unsubmitted
      // consent. Retain queued batches for the next lease, which rechecks them.
      await persist(true);
    }
  }
  private async assertCurrent(
    snapshot: ListingSnapshot,
    ids: number[],
  ): Promise<void> {
    const provider = await this.provider(snapshot.account.channelId);
    assertAccount(
      snapshot.account,
      await provider.account(snapshot.account.channelId),
    );
    const current = await this.catalogForIds(snapshot.account.channelId, ids);
    if (
      current.length !== ids.length ||
      current.some(
        (item) =>
          snapshot.catalog.find((prior) => prior.variantId === item.variantId)
            ?.sourceHash !== item.sourceHash,
      )
    )
      stale();
    const inventory = await this.dependencies.inventory.inspect(
      snapshot.account,
      current,
    );
    if (!inventory.ready)
      throw new ListingPublicationError(
        "LISTING_STOCK_SETUP_REQUIRED",
        inventory.message,
      );
    if (
      inventory.targetId !== snapshot.review.inventory.targetId ||
      inventory.targetRevision !== snapshot.review.inventory.targetRevision
    )
      stale();
  }
  private async catalogForIds(
    channelId: number,
    ids: number[],
  ): Promise<ListingCatalogItem[]> {
    return (
      await this.dependencies.catalog.catalog(channelId, {
        variantIds: ids.join(","),
      })
    ).items;
  }
  private async provider(channelId: number) {
    z.number().int().positive().parse(channelId);
    return this.dependencies.provider(channelId);
  }
  private now(): Date {
    const value = this.dependencies.now();
    if (!Number.isFinite(value.getTime()))
      throw new ListingPublicationError(
        "LISTING_CLOCK_INVALID",
        "Listing publication clock is invalid",
        500,
      );
    return value;
  }
  private uuid(): string {
    return z.string().uuid().parse(this.dependencies.uuid());
  }
}
function invalidatesReviewedBatch(error: unknown): boolean {
  return (
    error instanceof ListingPublicationError &&
    [
      "LISTING_REVIEW_STALE",
      "LISTING_ACCOUNT_CHANGED",
      "LISTING_STOCK_SETUP_REQUIRED",
      "LISTING_CURRENCY_UNSUPPORTED",
    ].includes(error.code)
  );
}
function requireNewBatchReview(
  progress: ListingProgress,
  batch: ListingProgress["batches"][number],
  error: unknown,
): void {
  batch.state = "processed";
  for (const item of progress.items)
    if (batch.variantIds.includes(item.variantId)) {
      item.state = "needs_attention";
      item.error = safeMessage(error);
      item.canRetry = true;
    }
}
function assertAccount(
  expected: ListingAccount,
  actual: ListingAccount,
  requireRevision = true,
): void {
  if (
    listingAccountKey(expected) !== listingAccountKey(actual) ||
    expected.channelId !== actual.channelId ||
    expected.connectionId !== actual.connectionId ||
    expected.scopeId !== actual.scopeId ||
    (requireRevision && expected.revision !== actual.revision)
  ) {
    throw new ListingPublicationError(
      "LISTING_ACCOUNT_CHANGED",
      "The account or fulfillment center changed; review the listing selection again",
    );
  }
}
function stale(): never {
  throw new ListingPublicationError(
    "LISTING_REVIEW_STALE",
    "Catalog, price, or selection changed; create a new review before publishing",
  );
}
function safeCode(error: unknown): string {
  return error instanceof ListingPublicationError ||
    error instanceof ChannelProviderError
    ? error.code
    : "LISTING_PUBLICATION_FAILED";
}
function safeMessage(error: unknown): string {
  return error instanceof ListingPublicationError ||
    error instanceof ChannelProviderError
    ? error.message
    : "Listing publication could not be completed; inspect the recorded operation before retrying.";
}
