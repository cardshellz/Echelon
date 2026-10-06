import { z } from "zod";
import {
  hasListingUpdateChanges,
  listingUpdateContextSchema,
  listingUpdateSkuSchema,
  reviewListingUpdateSchema,
  submitListingUpdateSchema,
  type ListingUpdateVerification,
} from "@shared/types/channel-listing-update";
import {
  ListingPublicationError,
  listingAccountKey,
  listingHash,
} from "../domain/listing-publication";
import {
  assertUpdateReview,
  assertUpdateSource,
  verifyListingUpdateObservation,
} from "../domain/listing-update";
import { ListingSubmissionError } from "./listing-publication-provider.port";
import type {
  ListingUpdateProvider,
  ListingUpdateStore,
  StoredListingUpdate,
} from "./listing-update-ports";
import { ChannelProviderError } from "../../channels/channel-provider.error";

const REVIEW_LIFETIME_MS = 15 * 60_000;
const actorSchema = z.string().trim().min(1).max(200);
export class ListingUpdateService {
  constructor(
    private readonly dependencies: {
      store: ListingUpdateStore;
      provider: ListingUpdateProvider;
      now(): Date;
      uuid(): string;
    },
  ) {}
  private now(): Date {
    const now = this.dependencies.now();
    if (!Number.isFinite(now.getTime()))
      throw new ListingPublicationError(
        "LISTING_UPDATE_CLOCK_INVALID",
        "The listing update clock is unavailable",
        500,
      );
    return now;
  }
  async context(channelId: number, input: unknown) {
    const sku = listingUpdateSkuSchema.parse(input);
    const account = await this.dependencies.provider.account(channelId);
    const current = await this.dependencies.provider.observe(account, sku);
    const [previous, updates] = await Promise.all([
      this.dependencies.store.lastSubmitted(
        account,
        sku,
        current.externalProductId,
      ),
      this.dependencies.store.list(channelId, sku, listingAccountKey(account)),
    ]);
    return listingUpdateContextSchema.parse({
      current,
      sourceHash: listingHash({ account, current }),
      suggestedProductType:
        current.productType && current.productType !== "default"
          ? current.productType
          : (previous?.productType ?? ""),
      lastSubmitted: previous?.changes ?? null,
      updates: updates.map((record) => record.view),
    });
  }
  async requirements(channelId: number, productType: unknown) {
    return this.dependencies.provider.requirements(
      await this.dependencies.provider.account(channelId),
      z.string().trim().min(1).max(200).parse(productType),
    );
  }
  async review(channelId: number, input: unknown, actor: string) {
    const command = reviewListingUpdateSchema.parse(input);
    const account = await this.dependencies.provider.account(channelId);
    const source = await this.dependencies.provider.observe(
      account,
      command.sku,
    );
    if (listingHash({ account, current: source }) !== command.sourceHash)
      throw new ListingPublicationError(
        "LISTING_UPDATE_STALE",
        "The Walmart listing changed. Reopen it and review your changes again.",
      );
    if (!hasListingUpdateChanges(command.changes))
      throw new ListingPublicationError(
        "LISTING_UPDATE_EMPTY",
        "Change at least one item field before reviewing. Selecting a product type alone sends no item content and does not confirm a category correction.",
        400,
      );
    const prepared = await this.dependencies.provider.prepare(
      account,
      source,
      command,
    );
    const now = this.now();
    const intent = { account, source, command, prepared };
    const record: StoredListingUpdate = {
      view: {
        id: z.string().uuid().parse(this.dependencies.uuid()),
        sku: source.sku,
        title: command.changes.title ?? source.title,
        state: "reviewed",
        reviewHash: listingHash(intent),
        productType: command.productType,
        changes: command.changes,
        issues: prepared.issues,
        submissionId: null,
        message: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + REVIEW_LIFETIME_MS).toISOString(),
      },
      intent,
      version: 1,
      leaseToken: null,
      commandKey: null,
    };
    await this.dependencies.store.insert(record, actorSchema.parse(actor));
    return record.view;
  }
  async submit(channelId: number, id: unknown, input: unknown, actor: string) {
    const command = submitListingUpdateSchema.parse(input);
    const record = await this.dependencies.store.get(
      channelId,
      z.string().uuid().parse(id),
    );
    if (record.view.reviewHash !== command.reviewHash)
      throw new ListingPublicationError(
        "LISTING_UPDATE_REVIEW_CHANGED",
        "The reviewed changes do not match this request.",
      );
    if (record.commandKey !== null) {
      if (record.commandKey !== command.commandKey)
        throw new ListingPublicationError(
          "LISTING_UPDATE_ALREADY_SENT",
          "These changes already have an update request. Check its status.",
        );
      return record.view;
    }
    assertUpdateReview(record, this.now());
    await this.assertCurrent(record);
    return (
      await this.dependencies.store.queue(
        record,
        command.commandKey,
        actorSchema.parse(actor),
        this.now(),
      )
    ).view;
  }
  async list(channelId: number) {
    const account = await this.dependencies.provider.account(channelId);
    return (
      await this.dependencies.store.list(
        channelId,
        undefined,
        listingAccountKey(account),
      )
    ).map((record) => record.view);
  }
  async refresh(channelId: number, id: unknown, actor: string) {
    await this.dependencies.provider.account(channelId);
    const updateId = z.string().uuid().parse(id);
    const record = await this.dependencies.store.refresh(
      channelId,
      updateId,
      actorSchema.parse(actor),
      this.now(),
    );
    // A status check only polls an already-receipted update; it cannot send a queued edit.
    if (record.view.state === "processing") await this.processDue(1, updateId);
    return (await this.dependencies.store.get(channelId, updateId)).view;
  }
  async verify(channelId: number, id: unknown): Promise<ListingUpdateVerification> {
    const account = await this.dependencies.provider.account(channelId);
    const record = await this.dependencies.store.get(
      channelId,
      z.string().uuid().parse(id),
    );
    // Credentials may rotate, but the seller, connection and fulfillment scope
    // must still be the ones that received this immutable update.
    assertUpdateSource(
      { ...record.intent.account, revision: account.revision },
      account,
    );
    if (record.view.state !== "accepted" || !record.view.submissionId) {
      throw new ListingPublicationError(
        "LISTING_UPDATE_NOT_ACCEPTED",
        "Wait for Walmart to process this feed before checking its item result.",
      );
    }
    const current = await this.dependencies.provider.observe(
      account,
      record.view.sku,
    );
    return verifyListingUpdateObservation(record, current, this.now());
  }
  private async assertCurrent(record: StoredListingUpdate) {
    const { account, source } = record.intent;
    assertUpdateSource(
      account,
      await this.dependencies.provider.account(account.channelId),
    );
    assertUpdateSource(
      source,
      await this.dependencies.provider.observe(account, source.sku),
    );
  }
  async processDue(
    limit = 5,
    id?: string,
  ): Promise<{ processed: number; failed: number }> {
    z.number().int().min(1).max(20).parse(limit);
    let processed = 0,
      failed = 0;
    for (let index = 0; index < limit; index++) {
      let record = await this.dependencies.store.claim(
        z.string().uuid().parse(this.dependencies.uuid()),
        this.now(),
        id,
      );
      if (!record) break;
      try {
        if (record.view.state === "uncertain") continue;
        if (record.view.state === "queued") {
          try {
            await this.assertCurrent(record);
          } catch (error) {
            if (!(error instanceof ListingPublicationError)) throw error;
            await this.dependencies.store.progress(
              record,
              "needs_attention",
              null,
              error.message,
              this.now(),
              true,
            );
            processed++;
            continue;
          }
          record = await this.dependencies.store.progress(
            record,
            "sending",
            null,
            null,
            this.now(),
            false,
          );
          let receipt: string;
          try {
            const sending = record;
            receipt = await this.dependencies.provider.send(
              record.intent,
              record.view.id,
              () => this.dependencies.store.renew(sending, this.now()),
            );
          } catch (error) {
            const uncertain =
              !(error instanceof ListingSubmissionError) ||
              error.effect === "uncertain";
            await this.dependencies.store.progress(
              record,
              uncertain ? "uncertain" : "needs_attention",
              null,
              uncertain
                ? "Walmart may have received this update, but no receipt was returned. Check Seller Center before sending more changes."
                : safeMessage(error),
              this.now(),
              true,
            );
            failed++;
            continue;
          }
          record = await this.dependencies.store.progress(
            record,
            "processing",
            receipt,
            "Walmart is processing these changes.",
            this.now(),
            false,
          );
        }
        if (record.view.state === "processing" && record.view.submissionId) {
          const result = await this.dependencies.provider.status(
            record.intent.account,
            record.view.submissionId,
            record.view.sku,
            record.intent.source.externalProductId,
          );
          await this.dependencies.store.progress(
            record,
            result.state,
            record.view.submissionId,
            result.message,
            this.now(),
            true,
          );
          processed++;
        }
      } catch (error) {
        failed++;
        console.error(
          JSON.stringify({
            operation: "listing_update_worker",
            id: record.view.id,
            code:
              error instanceof ListingPublicationError ||
              error instanceof ChannelProviderError
                ? error.code
                : "LISTING_UPDATE_WORKER_FAILED",
          }),
        );
        // A lease loss or failed receipt commit must never turn a sent request back into a queued request.
        if (
          !(
            error instanceof ListingPublicationError &&
            error.code === "LISTING_UPDATE_LEASE_LOST"
          )
        ) {
          await this.dependencies.store.progress(
            record,
            record.view.state,
            record.view.submissionId,
            safeMessage(error),
            this.now(),
            true,
          );
        }
      }
    }
    return { processed, failed };
  }
}
function safeMessage(error: unknown): string {
  return error instanceof ListingPublicationError ||
    error instanceof ChannelProviderError ||
    error instanceof ListingSubmissionError
    ? error.message
    : "The update could not be checked. Try refreshing its status.";
}
