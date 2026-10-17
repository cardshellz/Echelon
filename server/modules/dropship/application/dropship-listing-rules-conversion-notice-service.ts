import {
  LISTING_RULES_CONVERSION_ERROR_CODES,
  listingRulesConversionNoticeAcknowledgeInputSchema,
  type ListingRulesConversionNoticeAcknowledgeResponse,
} from "../../../../shared/dropship/listing-rules-conversion";
import { DropshipError } from "../domain/errors";
import {
  assertListingSettingMember,
  listingSettingStoreIdSchema,
  parseListingSettingInput,
  type ListingSettingWriteLog,
} from "./dropship-listing-setting-write-support";
import type { DropshipClock } from "./dropship-ports";

/**
 * [Got it] on the one-time notice of a system conversion (Listing settings PR
 * 11e1, plan 9.2, 9.3, D19): the vendor saw what the job moved, so the notice
 * stops showing, on every device. One vendor action, so a single write (the
 * 60-a-minute budget, plan P7).
 *
 * It changes no listing value, so it takes no store lock, no gate and no
 * heavy-write gate: one short transaction that resolves the store's owner
 * by member (FOR SHARE) and marks the notice seen with its audit row
 * (`acknowledgeNoticeWithClient`). It is idempotent by state, so it carries
 * no request key (plan 16): a second press, or a press on another device,
 * answers `already_seen` and writes nothing. An id that names no system
 * conversion of this store is the permanent 404
 * `DROPSHIP_LISTING_CONVERSION_NOTICE_NOT_FOUND`.
 */

/** What the notice's transaction answers: the owner it resolved and what the press did. */
export interface ListingRulesConversionNoticeAcknowledgeResult {
  vendorId: number;
  outcome: "acknowledged" | "already_seen" | "not_found";
}

export interface ListingRulesConversionNoticeRepository {
  /**
   * One transaction (READ COMMITTED): the store's owner rows by member FOR
   * SHARE (404 `DROPSHIP_STORE_CONNECTION_REQUIRED` when the member's vendor
   * does not own the store), then the guarded UPDATE and, for the one row it
   * marks, the audit row. Database failures are mapped as a listing write's.
   */
  acknowledgeNotice(input: {
    memberId: string; storeConnectionId: number; conversionId: number; now: Date;
  }): Promise<ListingRulesConversionNoticeAcknowledgeResult>;
}

export interface DropshipListingRulesConversionNoticeServiceDependencies {
  repository: ListingRulesConversionNoticeRepository;
  clock: DropshipClock;
  /** Monotonic milliseconds, for `elapsed_ms` only; the write's time is `clock`, read once. */
  timer: () => number;
  log: ListingSettingWriteLog;
}

/** The one INFO line after a press commits (plan 3.5). */
export const RULES_CONVERSION_NOTICE_SEEN_ACTION = "dropship.listing_settings.rules_conversion_notice_seen";

export class DropshipListingRulesConversionNoticeService {
  constructor(private readonly deps: DropshipListingRulesConversionNoticeServiceDependencies) {}

  async acknowledgeForMember(memberId: string, storeId: unknown, body: unknown): Promise<ListingRulesConversionNoticeAcknowledgeResponse> {
    assertListingSettingMember(memberId);
    const storeConnectionId = parseListingSettingInput(listingSettingStoreIdSchema, storeId);
    const { conversionId } = parseListingSettingInput(listingRulesConversionNoticeAcknowledgeInputSchema, body);
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    const { vendorId, outcome } = await this.deps.repository.acknowledgeNotice({ memberId, storeConnectionId, conversionId, now });
    if (outcome === "not_found") throw conversionNoticeNotFound(storeConnectionId, conversionId);
    const acknowledged = outcome === "acknowledged";
    this.deps.log.info(RULES_CONVERSION_NOTICE_SEEN_ACTION, {
      outcome,
      vendor_id: vendorId,
      store_connection_id: storeConnectionId,
      conversion_id: conversionId,
      actor_type: "vendor",
      actor_id: memberId,
      // `already_seen` wrote nothing: the notice was seen before this press and still is.
      before: { notice_seen: !acknowledged },
      after: { notice_seen: true },
      elapsed_ms: Math.max(0, Math.round(this.deps.timer() - started)),
    });
    return { outcome };
  }
}

/** No system conversion with that id on this store (plan 3.4): permanent, never retried. */
export function conversionNoticeNotFound(storeConnectionId: number, conversionId: number): DropshipError {
  return new DropshipError(LISTING_RULES_CONVERSION_ERROR_CODES.noticeNotFound,
    "That note about moved group rules was not found for this store. Reload the page.", {
      storeConnectionId, conversionId, retryable: false, classification: "permanent",
    });
}
