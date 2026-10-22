import { z } from "zod";
import { ListingMemberRecoveryService, type ListingMemberRecoveryScope } from "./listing-member-recovery.service";
import type { ListingMemberLifecycleDependencies } from "./listing-member-lifecycle.port";
import { processListingMemberRetirement } from "./process-listing-member-retirement";
import {
  listingLifecycleCommandSchema,
  listingLifecycleListSchema,
  listingLifecycleSkuSchema,
  listingLifecycleViewSchema,
} from "@shared/types/channel-listing-lifecycle";
import {
  listingAccountSchema,
  type ListingAccount,
} from "@shared/types/channel-listing-publication";
import {
  ListingPublicationError,
  listingAccountKey,
} from "../domain/listing-publication";
import {
  listingLifecycleHistoryRequestSchema,
  listingLifecycleHistorySchema,
} from "@shared/types/channel-listing-lifecycle";
import type {
  ListingLifecycleProvider,
  ListingLifecycleStore,
  ListingLifecycleSession,
  StoredListingLifecycle,
} from "./listing-lifecycle-ports";

const channelIdSchema = z.number().int().positive().max(2_147_483_647);
const actorSchema = z.string().trim().min(1).max(100);
function assertAccount(
  expected: ListingAccount,
  current: ListingAccount,
  exactRevision: boolean,
): void {
  if (
    listingAccountKey(expected) !== listingAccountKey(current) ||
    expected.channelId !== current.channelId ||
    expected.connectionId !== current.connectionId ||
    expected.scopeId !== current.scopeId ||
    (exactRevision && expected.revision !== current.revision)
  ) {
    throw new ListingPublicationError(
      "LISTING_LIFECYCLE_ACCOUNT_CHANGED",
      "The Walmart connection changed. Refresh the listing before continuing.",
    );
  }
}

export class ListingLifecycleService {
  constructor(
    private readonly dependencies: {
      store: ListingLifecycleStore;
      provider: ListingLifecycleProvider;
      now(): Date;
      uuid(): string;
      members?: ListingMemberLifecycleDependencies;
      checkPresence?(account: ListingAccount, sku: string): Promise<unknown>;
    },
  ) {}
  private now(): Date {
    return z.date().parse(this.dependencies.now());
  }
  private memberRecovery(): ListingMemberRecoveryService {
    if (!this.dependencies.members) throw new ListingPublicationError("LISTING_LIFECYCLE_UNAVAILABLE", "Listing retirement recovery is unavailable.", 503);
    return new ListingMemberRecoveryService(this.dependencies.members, () => this.now());
  }
  memberRecoveryPreview(channelId: ListingMemberRecoveryScope, input: unknown) {
    const request = z.object({ operationId: z.string().uuid() }).strict().parse(input);
    return this.memberRecovery().preview(channelId, request.operationId);
  }
  resumeMemberRecovery(channelId: ListingMemberRecoveryScope, input: unknown, actor: string) {
    return this.memberRecovery().resume(channelId, input, actor);
  }
  async memberHistory(channelId: ListingMemberRecoveryScope, input: unknown) {
    const request = z.object({ productId: channelIdSchema, limit: z.number().int().min(1).max(250).default(100) }).strict().parse(input);
    if (!this.dependencies.members) throw new ListingPublicationError("LISTING_LIFECYCLE_UNAVAILABLE", "Listing retirement history is unavailable.", 503);
    if (typeof channelId === "number")
      return { items: await this.dependencies.members.store.listForChannel(channelIdSchema.parse(channelId), request.productId, request.limit) };
    const scope = z.object({connectionId:channelIdSchema,vendorId:channelIdSchema}).strict().parse(channelId);
    if (!this.dependencies.members.store.listForDropship) throw new ListingPublicationError("LISTING_LIFECYCLE_UNAVAILABLE","Listing retirement history is unavailable.",503);
    return {items:await this.dependencies.members.store.listForDropship(scope.connectionId,scope.vendorId,request.productId,request.limit)};
  }
  async list(channelId: number, rawSkus: unknown) {
    const skus = z.array(listingLifecycleSkuSchema).max(250).parse(rawSkus);
    const account = listingAccountSchema.parse(
      await this.dependencies.provider.account(
        channelIdSchema.parse(channelId),
      ),
    );
    return listingLifecycleListSchema.parse({
      account,
      items: await this.dependencies.store.list(account, skus),
      presence: await this.dependencies.store.presence?.(account, skus) ?? [],
    });
  }
  async refreshPresence(channelId: number, rawSkus: unknown) {
    const skus = z.array(listingLifecycleSkuSchema).max(250).parse(rawSkus);
    const account = listingAccountSchema.parse(await this.dependencies.provider.account(channelIdSchema.parse(channelId)));
    if (!this.dependencies.checkPresence) throw new ListingPublicationError("LISTING_PRESENCE_UNAVAILABLE", "Listing checks are unavailable.", 503);
    for (const sku of new Set(skus)) await this.dependencies.checkPresence(account, sku);
    return this.list(channelId, skus);
  }
  async request(channelId: number, raw: unknown, actorInput: string) {
    const command = listingLifecycleCommandSchema.parse(raw);
    const actor = actorSchema.parse(actorInput);
    const account = listingAccountSchema.parse(
      await this.dependencies.provider.account(
        channelIdSchema.parse(channelId),
      ),
    );
    assertAccount(command.account, account, true);
    return this.dependencies.store.withListing(
      account,
      command.sku,
      async (session) => {
        const previous = await session.find(command.sku);
        // A lost HTTP response retries the same desired state, without another
        // provider write or duplicate audit event. Removal is a monotonic upgrade.
        if (
          previous &&
          (previous.view.action === "remove" ||
            previous.view.action === command.action)
        )
          return previous.view;
        const observed = previous
          ? null
          : await this.dependencies.provider.observe(account, command.sku);
        if (observed && observed.sku !== command.sku)
          throw new ListingPublicationError(
            "LISTING_LIFECYCLE_SKU_CHANGED",
            "Walmart returned a different SKU.",
          );
        const record = await session.request(
          command,
          previous?.view.title ?? observed!.title,
          actor,
          z.string().uuid().parse(this.dependencies.uuid()),
          this.now(),
        );
        return listingLifecycleViewSchema.parse(record.view);
      },
    );
  }
  async history(channelId: number, raw: unknown) {
    const request = listingLifecycleHistoryRequestSchema.parse(raw);
    const account = listingAccountSchema.parse(
      await this.dependencies.provider.account(
        channelIdSchema.parse(channelId),
      ),
    );
    const pageSize = 100;
    const items = await this.dependencies.store.history(
      account,
      request.afterSku,
      request.sku,
      pageSize + 1,
    );
    return listingLifecycleHistorySchema.parse({
      account,
      items: items.slice(0, pageSize),
      nextSku: items.length > pageSize ? items[pageSize - 1].sku : null,
    });
  }
  async refresh(channelId: number, rawSku: unknown) {
    const sku = listingLifecycleSkuSchema.parse(rawSku);
    const account = await this.dependencies.provider.account(
      channelIdSchema.parse(channelId),
    );
    return this.dependencies.store.withListing(
      account,
      sku,
      async (session) => {
        const record = await session.find(sku);
        if (!record)
          throw new ListingPublicationError(
            "LISTING_LIFECYCLE_MISSING",
            "No unpublish request exists for this listing.",
            404,
          );
        return (await this.process(session, record)).view;
      },
    );
  }
  async processDue(limit = 25): Promise<{ processed: number; failed: number }> {
    z.number().int().min(1).max(100).parse(limit);
    let processed = 0,
      failed = 0;
    const members = this.dependencies.members;
    if (members) {
      await members.store.discover(this.now(), limit);
      for (const id of await members.store.due(this.now(), limit)) {
        try {
          const result = await members.store.withMember(id, session => processListingMemberRetirement(session, members, () => this.now()));
          if (result?.state === "failed") failed++;
          else if (result) processed++;
        } catch (error) {
          failed++;
          console.error(JSON.stringify({ operation: "listing_member_worker", operationId: id, code: "LISTING_MEMBER_WORKER_FAILED" }));
        }
      }
    }
    for (const candidate of await this.dependencies.store.due(
      this.now(),
      limit,
    )) {
      try {
        const result = await this.dependencies.store.withListing(
          candidate.account,
          candidate.view.sku,
          async (session) => {
            const record = await session.find(candidate.view.sku);
            return record && record.view.state !== "retired"
              ? this.process(session, record)
              : record;
          },
        );
        if (result?.view.state === "failed") failed++;
        else if (result) processed++;
      } catch (error) {
        failed++;
        console.error(
          JSON.stringify({
            operation: "listing_lifecycle_worker",
            id: candidate.view.id,
            code:
              error instanceof ListingPublicationError
                ? error.code
                : "LISTING_LIFECYCLE_WORKER_FAILED",
          }),
        );
      }
    }
    return { processed, failed };
  }
  private async process(
    session: ListingLifecycleSession,
    record: StoredListingLifecycle,
  ): Promise<StoredListingLifecycle> {
    if (record.view.state === "retired") return record;
    try {
      const current = await this.dependencies.provider.account(
        record.account.channelId,
      );
      assertAccount(record.account, current, false);
      await this.dependencies.provider.holdStock(
        current,
        record.view.sku,
        record.view.id,
        record.actor,
      );
      // Earlier feeds can still change the provider catalog after acceptance.
      // Let their owners finish polling before sending the retirement request.
      if (await session.hasPendingFeed(record.view.sku)) {
        return session.progress(
          record,
          "pending",
          "Waiting for an earlier Walmart submission to finish. Further publication is stopped.",
          this.now(),
        );
      }
      const observed = await this.dependencies.provider.observe(
        current,
        record.view.sku,
      );
      if (observed.sku !== record.view.sku)
        throw new ListingPublicationError(
          "LISTING_LIFECYCLE_SKU_CHANGED",
          "Walmart returned a different SKU.",
        );
      if (observed.retired)
        return session.progress(
          record,
          "retired",
          "Walmart confirmed this listing is unpublished.",
          this.now(),
        );
      if (record.view.state !== "retiring")
        await this.dependencies.provider.retire(
          current,
          record.view.sku,
          record.view.id,
        );
      return session.progress(
        record,
        "retiring",
        "Walmart is processing the unpublish request. Confirmation can take up to 48 hours.",
        this.now(),
      );
    } catch (error) {
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "LISTING_LIFECYCLE_FAILED";
      console.error(
        JSON.stringify({
          operation: "listing_lifecycle",
          id: record.view.id,
          code,
        }),
      );
      // Keep the durable publication stop even when the provider or stock hold
      // fails. The worker and the operator can safely retry the same request.
      return session.progress(
        record,
        "failed",
        `Unpublishing could not be confirmed (${code}). Publication remains stopped. Check again to retry.`,
        this.now(),
      );
    }
  }
}
