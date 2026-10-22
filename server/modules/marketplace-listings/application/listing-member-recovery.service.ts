import { z } from "zod";
import {
  listingMemberRecoveryCommandSchema,
  listingMemberRecoveryReviewSchema,
  type ListingMemberRecoveryReview,
} from "@shared/types/listing-member-lifecycle";
import {
  validateListingMemberObservation,
  ListingMemberLifecycleError,
} from "../domain/listing-member-lifecycle";
import { listingHash } from "../domain/listing-publication";
import type {
  ListingMemberLifecycleDependencies,
  ListingMemberLifecycleSession,
} from "./listing-member-lifecycle.port";

const operationIdSchema = z.string().uuid();
const actorSchema = z.string().trim().min(1).max(100);
export type ListingMemberRecoveryScope =
  number | { connectionId: number; vendorId: number };
const channelIdSchema = z.number().int().positive().max(2147483647);

/** Recovery belongs to the shared member lifecycle. Adapters supply observations
 * only; authorization, exact scope, replay and write scheduling stay here. */
export class ListingMemberRecoveryService {
  constructor(
    private readonly dependencies: ListingMemberLifecycleDependencies,
    private readonly now: () => Date,
  ) {}

  private async withMember<T>(
    channelId: ListingMemberRecoveryScope,
    id: string,
    work: (session: ListingMemberLifecycleSession) => Promise<T>,
  ): Promise<T> {
    const scope =
      typeof channelId === "number"
        ? channelIdSchema.parse(channelId)
        : z
            .object({
              connectionId: channelIdSchema,
              vendorId: channelIdSchema,
            })
            .strict()
            .parse(channelId);
    operationIdSchema.parse(id);
    const result = await this.dependencies.store.withMember(
      id,
      async (session) => {
        const identity = session.current.identity;
        const matches =
          typeof scope === "number"
            ? identity.destinationKind === "channel_connection" &&
              identity.channelId === scope
            : identity.destinationKind === "dropship_store_connection" &&
              identity.connectionId === scope.connectionId &&
              identity.vendorId === scope.vendorId;
        if (!matches)
          throw new ListingMemberLifecycleError(
            "LISTING_MEMBER_RECOVERY_SCOPE_CHANGED",
            "This removal belongs to a different channel.",
          );
        return work(session);
      },
    );
    if (result === null)
      throw new ListingMemberLifecycleError(
        "LISTING_MEMBER_RECOVERY_BUSY",
        "This removal is in use or no longer available. Refresh and try again.",
      );
    return result;
  }
  private async inspect(
    session: ListingMemberLifecycleSession,
  ): Promise<ListingMemberRecoveryReview> {
    const record = session.current;
    if (
      !(await session.isCurrent()) ||
      record.identity.identityConflict ||
      record.state === "superseded"
    )
      throw new ListingMemberLifecycleError(
        "LISTING_MEMBER_RECOVERY_SCOPE_CHANGED",
        "The catalog or listing link changed. Refresh the current member; this older request cannot remove it.",
      );
    const adapter = await this.dependencies.adapter(record.identity);
    const observation = validateListingMemberObservation(
      await adapter.observe(record.identity),
      record.identity,
    );
    const reviewHash = listingHash({
      operationId: record.operationId,
      sourceRevision: record.sourceRevision,
      version: record.version,
      identity: record.identity,
      dispatchStatus: record.dispatchStatus,
      observation,
    });
    return listingMemberRecoveryReviewSchema.parse({
      record,
      observation,
      reviewHash,
      canResume:
        record.state !== "retired" &&
        (record.recoveryRequired === true || record.state === "retiring"),
      message:
        record.state === "retired"
          ? "Removal of this exact member has been verified."
          : record.state === "pending" && record.dispatchStatus === "authorized"
            ? "Recovery is queued. The listing lifecycle will verify and remove this exact archived member."
            : observation.retired
              ? "The exact member is already removed. Continue to save verified completion."
              : "The exact archived member is still published. Continuing authorizes another removal attempt. The earlier unconfirmed outcome remains in history.",
    });
  }
  private async fenced<T>(
    session: ListingMemberLifecycleSession,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!this.dependencies.withPublicationFence) return work();
    return this.dependencies.withPublicationFence(
      session.current.identity,
      (pending) => {
        if (pending)
          throw new ListingMemberLifecycleError(
            "LISTING_MEMBER_EARLIER_PUBLICATION_PENDING",
            "An earlier channel submission is still pending. Wait for its receipt before authorizing removal again.",
          );
        return work();
      },
    );
  }
  preview(
    channelId: ListingMemberRecoveryScope,
    operationId: string,
  ): Promise<ListingMemberRecoveryReview> {
    return this.withMember(channelId, operationId, (session) =>
      this.fenced(session, () => this.inspect(session)),
    );
  }
  async resume(
    channelId: ListingMemberRecoveryScope,
    raw: unknown,
    actorInput: string,
  ) {
    const command = listingMemberRecoveryCommandSchema.parse(raw),
      actor = actorSchema.parse(actorInput);
    return this.withMember(channelId, command.operationId, async (session) => {
      if (!session.recoveryCommand || !session.authorizeRecovery)
        throw new ListingMemberLifecycleError(
          "LISTING_MEMBER_RECOVERY_UNAVAILABLE",
          "Durable removal recovery is unavailable.",
        );
      // Receipt-first replay survives completion/reactivation without a second write.
      const receipt = await session.recoveryCommand(command.commandKey);
      if (receipt) {
        if (
          receipt.operationId !== command.operationId ||
          receipt.actor !== actor ||
          receipt.reviewHash !== command.reviewHash
        )
          throw new ListingMemberLifecycleError(
            "LISTING_MEMBER_RECOVERY_REPLAY_CONFLICT",
            "This command was used for a different recovery review.",
          );
        return session.current;
      }
      return this.fenced(session, async () => {
        const review = await this.inspect(session);
        if (!review.canResume || review.reviewHash !== command.reviewHash)
          throw new ListingMemberLifecycleError(
            "LISTING_MEMBER_RECOVERY_REVIEW_STALE",
            "Removal evidence changed. Refresh the recovery review before continuing.",
          );
        return session.authorizeRecovery!(
          { ...command, actor, observation: review.observation },
          z.date().parse(this.now()),
        );
      });
    });
  }
}
