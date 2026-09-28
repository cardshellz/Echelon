import { z } from "zod";
import type { CostChangeEventType, DropshipCostChangePolicySettings } from "../../../../shared/dropship/cost-change-policy";
import {
  costChangeNoticeChannels,
  costChangeNoticeIdempotencyKey,
  decideCostChangeNotice,
  type CostChangeNoticeDecision,
  type CostChangeNoticeKind,
} from "../domain/cost-change-notice";
import { DropshipError } from "../domain/errors";
import {
  VENDOR_COST_LISTING_ACTION_RECENT_DAYS,
  VENDOR_COST_LISTING_ACTION_VIEW_LIMIT,
  type DropshipCostChangeListingActionRepository,
  type VendorCostChangeListingActionView,
} from "./dropship-cost-change-listing-action-service";
import type { CostScheduleRecorder, DropshipCostChangePolicyReader } from "./dropship-cost-detection-service";
import { formatNotificationCurrency, formatNotificationDate } from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type { DropshipClock, DropshipLogger, DropshipNotificationSender } from "./dropship-ports";

/**
 * Vendor notices for .ops cost changes (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, C4).
 *
 * The notice pass walks change log rows that have no decision yet, in
 * reading order, one reading (vendor, observed time, writer) at a time. Each
 * row is decided by the pure rules in domain/cost-change-notice.ts under the
 * policy in force; the rows to send are grouped by kind into ONE notification
 * per reading and kind, sent through the notification service under a
 * deterministic key, and every decision is recorded in
 * dropship.dropship_cost_change_notices. The send happens before the record:
 * a crash in between is replayed under the same key on the next pass, so the
 * vendor is never told twice.
 *
 * ASSUMPTION: .ops costs are in USD (the Shopify store's currency); the
 * schedule carries no currency column.
 */

export const DEFAULT_COST_NOTICE_GROUPS_PER_PASS = 20;
export const MAX_COST_NOTICE_GROUPS_PER_PASS = 200;
/** How many changes one notification lists in full; the rest are counted. */
export const COST_NOTICE_LISTED_CHANGES = 10;
/** How many changes the notification's payload carries. */
export const COST_NOTICE_PAYLOAD_CHANGES = 100;
/** The vendor's portal view lists announced changes and the recent log, bounded. */
export const VENDOR_COST_CHANGE_VIEW_LIMIT = 200;
export const VENDOR_COST_CHANGE_RECENT_DAYS = 30;
const COST_NOTICE_CURRENCY = "USD";
const MILLISECONDS_PER_DAY = 86_400_000;

export interface CostChangeNoticeGroup {
  vendorId: number;
  observedAt: Date;
  recordedBy: CostScheduleRecorder;
  firstLogId: number;
  rowCount: number;
}

export interface CostChangeNoticeLogRow {
  logId: number;
  entryId: number;
  vendorId: number;
  productVariantId: number;
  variantSku: string | null;
  variantName: string;
  productName: string;
  eventType: CostChangeEventType;
  fromCents: number | null;
  toCents: number | null;
  effectiveAt: Date;
  observedAt: Date;
  recordedBy: CostScheduleRecorder;
  policyId: number | null;
}

export interface CostChangeNoticeDecisionRecord {
  logId: number;
  vendorId: number;
  productVariantId: number;
  entryId: number;
  eventType: CostChangeEventType;
  decision: CostChangeNoticeDecision;
  noticeKind: CostChangeNoticeKind | null;
  noticeEventType: string | null;
  idempotencyKey: string | null;
  policyId: number | null;
  decidedAt: Date;
}

/** An announced change on one of the vendor's listings, as the portal shows it. */
export interface VendorCostChangeView {
  entryId: number;
  productVariantId: number;
  variantSku: string | null;
  variantName: string;
  productName: string;
  kind: "increase" | "decrease";
  fromCents: number;
  unitCostCents: number;
  effectiveAt: Date;
  announcedAt: Date;
}

export interface VendorCostChangeLogView {
  logId: number;
  productVariantId: number;
  variantSku: string | null;
  variantName: string;
  productName: string;
  eventType: CostChangeEventType;
  fromCents: number | null;
  toCents: number | null;
  effectiveAt: Date;
  observedAt: Date;
  noticeDecision: CostChangeNoticeDecision | null;
}

export interface DropshipCostChangeNoticeRepository {
  listUnnoticedGroups(input: { limit: number }): Promise<CostChangeNoticeGroup[]>;
  loadGroupRows(group: Pick<CostChangeNoticeGroup, "vendorId" | "observedAt" | "recordedBy">): Promise<CostChangeNoticeLogRow[]>;
  /** Entries among the given ones whose announcement was sent. */
  listSentEntryIds(entryIds: readonly number[]): Promise<ReadonlySet<number>>;
  /** Records decisions, ignoring rows already decided; returns how many were written. */
  recordDecisions(records: readonly CostChangeNoticeDecisionRecord[]): Promise<number>;
  listVendorAnnouncedChanges(input: { vendorId: number; now: Date; limit: number }): Promise<VendorCostChangeView[]>;
  listVendorRecentChanges(input: { vendorId: number; since: Date; limit: number }): Promise<VendorCostChangeLogView[]>;
}

export interface DropshipCostChangeVendorResolver {
  provisionForMember(memberId: string): Promise<{ vendor: { vendorId: number } }>;
}

export interface DropshipCostNoticePassResult {
  groupsProcessed: number;
  groupsFailed: number;
  /** Readings left for a later pass because an earlier reading of the same vendor failed in this one. */
  groupsDeferred: number;
  noticesSent: number;
  rowsDecided: number;
  decisions: Record<CostChangeNoticeDecision, number>;
}

export interface DropshipVendorCostChangeOverview {
  announced: VendorCostChangeView[];
  recent: VendorCostChangeLogView[];
  /** What increases that took effect did to the vendor's listings (C5), last month. */
  listingActions: VendorCostChangeListingActionView[];
  policy: Pick<DropshipCostChangePolicySettings, "increaseNoticeDays" | "decreaseTiming" | "priceProtection" | "notifyByEmail" | "notifyInPortal" | "notifyOnDecrease">;
  generatedAt: Date;
}

export const runDropshipCostNoticePassInputSchema = z.object({
  workerId: z.string().trim().min(1).max(200),
  groupsPerPass: z.number().int().min(1).max(MAX_COST_NOTICE_GROUPS_PER_PASS).optional(),
}).strict();

export class DropshipCostChangeNoticeService {
  constructor(
    private readonly deps: {
      repository: DropshipCostChangeNoticeRepository;
      listingActions: Pick<DropshipCostChangeListingActionRepository, "listVendorListingActions">;
      policy: DropshipCostChangePolicyReader;
      notificationSender?: DropshipNotificationSender;
      vendorProvisioning: DropshipCostChangeVendorResolver;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async runNoticePass(input: unknown): Promise<DropshipCostNoticePassResult> {
    const parsed = parseInput(runDropshipCostNoticePassInputSchema, input);
    const groupsPerPass = parsed.groupsPerPass ?? DEFAULT_COST_NOTICE_GROUPS_PER_PASS;
    const policy = await this.deps.policy.resolvePolicy();
    const result = emptyPassResult();
    const groups = await this.deps.repository.listUnnoticedGroups({ limit: groupsPerPass });
    // A vendor's readings are decided in order: a lowered or withdrawn change is
    // announced only when its announcement went out, so once one of a vendor's
    // readings fails, the vendor's later readings wait for it instead of being
    // judged "unannounced" ahead of it.
    const vendorsWithFailure = new Set<number>();
    for (const group of groups) {
      if (vendorsWithFailure.has(group.vendorId)) {
        result.groupsDeferred += 1;
        continue;
      }
      try {
        const outcome = await this.processGroup(group, policy, parsed.workerId);
        result.groupsProcessed += 1;
        result.noticesSent += outcome.noticesSent;
        result.rowsDecided += outcome.rowsDecided;
        for (const key of Object.keys(result.decisions) as CostChangeNoticeDecision[]) result.decisions[key] += outcome.decisions[key];
      } catch (error) {
        // The group stays undecided and is retried on the next pass; nothing was recorded for it.
        vendorsWithFailure.add(group.vendorId);
        result.groupsFailed += 1;
        this.deps.logger.warn({
          code: "DROPSHIP_COST_CHANGE_NOTICE_GROUP_FAILED",
          message: "A cost change notice group could not be sent or recorded; it is retried on the next pass.",
          context: {
            action: "cost_change_notice_group", outcome: "failed", classification: "transient", workerId: parsed.workerId,
            vendorId: group.vendorId, observedAt: group.observedAt.toISOString(), recordedBy: group.recordedBy,
            error: error instanceof Error ? error.message : String(error),
            errorCode: error instanceof DropshipError ? error.code : null,
          },
        });
      }
    }
    if (result.groupsProcessed > 0 || result.groupsFailed > 0) {
      this.deps.logger.info({
        code: "DROPSHIP_COST_CHANGE_NOTICE_PASS_COMPLETED",
        message: "Dropship cost change notice pass completed.",
        context: { action: "cost_change_notice_pass", outcome: "completed", workerId: parsed.workerId, policyId: policy.policyId, ...result },
      });
    }
    return result;
  }

  async getVendorViewForMember(memberId: string): Promise<DropshipVendorCostChangeOverview> {
    if (typeof memberId !== "string" || memberId.trim().length === 0) {
      throw new DropshipError("DROPSHIP_COST_CHANGE_INVALID_INPUT", "A member id is required.", { classification: "permanent" });
    }
    const vendor = await this.deps.vendorProvisioning.provisionForMember(memberId);
    return this.getVendorView(vendor.vendor.vendorId);
  }

  async getVendorView(vendorId: number): Promise<DropshipVendorCostChangeOverview> {
    if (!Number.isSafeInteger(vendorId) || vendorId <= 0) {
      throw new DropshipError("DROPSHIP_COST_CHANGE_INVALID_INPUT", "A vendor id is required.", { classification: "permanent", vendorId });
    }
    const now = this.deps.clock.now();
    const since = new Date(now.getTime() - VENDOR_COST_CHANGE_RECENT_DAYS * MILLISECONDS_PER_DAY);
    const [policy, announced, recent, listingActions] = await Promise.all([
      this.deps.policy.resolvePolicy(),
      this.deps.repository.listVendorAnnouncedChanges({ vendorId, now, limit: VENDOR_COST_CHANGE_VIEW_LIMIT }),
      this.deps.repository.listVendorRecentChanges({ vendorId, since, limit: VENDOR_COST_CHANGE_VIEW_LIMIT }),
      this.deps.listingActions.listVendorListingActions({
        vendorId, since: new Date(now.getTime() - VENDOR_COST_LISTING_ACTION_RECENT_DAYS * MILLISECONDS_PER_DAY), limit: VENDOR_COST_LISTING_ACTION_VIEW_LIMIT,
      }),
    ]);
    const { increaseNoticeDays, decreaseTiming, priceProtection, notifyByEmail, notifyInPortal, notifyOnDecrease } = policy.settings;
    return {
      announced,
      recent,
      listingActions,
      policy: { increaseNoticeDays, decreaseTiming, priceProtection, notifyByEmail, notifyInPortal, notifyOnDecrease },
      generatedAt: now,
    };
  }

  private async processGroup(
    group: CostChangeNoticeGroup,
    policy: { policyId: number | null; settings: DropshipCostChangePolicySettings },
    workerId: string,
  ): Promise<{ noticesSent: number; rowsDecided: number; decisions: Record<CostChangeNoticeDecision, number> }> {
    const rows = await this.deps.repository.loadGroupRows(group);
    const sentEntries = await this.deps.repository.listSentEntryIds(rows.map((row) => row.entryId));
    const decidedAt = this.deps.clock.now();
    const decisions = emptyDecisionCounts();
    const records: CostChangeNoticeDecisionRecord[] = [];
    const byKind = new Map<CostChangeNoticeKind, CostChangeNoticeLogRow[]>();

    for (const row of rows) {
      const verdict = decideCostChangeNotice({
        eventType: row.eventType,
        fromCents: row.fromCents,
        toCents: row.toCents,
        previouslySent: sentEntries.has(row.entryId),
        settings: policy.settings,
      });
      decisions[verdict.decision] += 1;
      const kind = verdict.kind;
      const key = kind ? costChangeNoticeIdempotencyKey({ vendorId: group.vendorId, kind, recordedBy: group.recordedBy, observedAt: group.observedAt }) : null;
      records.push({
        logId: row.logId, vendorId: row.vendorId, productVariantId: row.productVariantId, entryId: row.entryId, eventType: row.eventType,
        decision: verdict.decision, noticeKind: kind, noticeEventType: kind ? noticeEventTypeFor(kind) : null, idempotencyKey: key,
        policyId: policy.policyId, decidedAt,
      });
      if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), row]);
    }

    let noticesSent = 0;
    for (const [kind, kindRows] of byKind) {
      if (!this.deps.notificationSender) {
        // No sender is wired: the decision must not claim a notice went out.
        throw new DropshipError("DROPSHIP_COST_CHANGE_NOTICE_SENDER_MISSING", "No notification sender is configured for cost change notices.",
          { classification: "fatal", vendorId: group.vendorId });
      }
      const notice = buildCostChangeNotice({ kind, rows: kindRows, settings: policy.settings });
      await this.deps.notificationSender.send({
        vendorId: group.vendorId,
        eventType: noticeEventTypeFor(kind),
        critical: false,
        channels: costChangeNoticeChannels(policy.settings),
        title: notice.title,
        message: notice.message,
        payload: {
          ...notice.payload, recordedBy: group.recordedBy, observedAt: group.observedAt.toISOString(), policyId: policy.policyId, workerId,
        },
        idempotencyKey: costChangeNoticeIdempotencyKey({ vendorId: group.vendorId, kind, recordedBy: group.recordedBy, observedAt: group.observedAt }),
      });
      noticesSent += 1;
    }

    const rowsDecided = await this.deps.repository.recordDecisions(records);
    return { noticesSent, rowsDecided, decisions };
  }
}

export function noticeEventTypeFor(kind: CostChangeNoticeKind): string {
  switch (kind) {
    case "announced":
      return DROPSHIP_NOTIFICATION_EVENTS.COST_CHANGE_ANNOUNCED;
    case "applied":
      return DROPSHIP_NOTIFICATION_EVENTS.COST_CHANGE_APPLIED;
    case "updated":
      return DROPSHIP_NOTIFICATION_EVENTS.COST_CHANGE_UPDATED;
  }
}

/** The words of one grouped notice. Pure. */
export function buildCostChangeNotice(input: {
  kind: CostChangeNoticeKind;
  rows: readonly CostChangeNoticeLogRow[];
  settings: Pick<DropshipCostChangePolicySettings, "priceProtection">;
}): { title: string; message: string; payload: Record<string, unknown> } {
  const rows = [...input.rows].sort((left, right) => left.logId - right.logId);
  if (rows.length === 0) throw new RangeError("A notice needs at least one change.");
  const count = rows.length;
  const plural = count === 1 ? "" : "s";
  const listed = rows.slice(0, COST_NOTICE_LISTED_CHANGES).map((row) => `- ${describeRow(row, input.kind)}`);
  const remainder = count > COST_NOTICE_LISTED_CHANGES ? [`- and ${(count - COST_NOTICE_LISTED_CHANGES).toLocaleString("en-US")} more`] : [];
  let title: string;
  let lead: string;
  let closing: string;
  switch (input.kind) {
    case "announced": {
      const date = formatNotificationDate(rows[0]!.effectiveAt);
      title = count === 1 ? `A .ops cost on your listings changes on ${date}` : `${count} .ops costs on your listings change on ${date}`;
      lead = `From ${date}, ${count === 1 ? "this .ops cost changes" : `these ${count} .ops costs change`}:`;
      closing = input.settings.priceProtection
        ? "Orders accepted before that date are charged the current cost."
        : "Orders are charged the new cost as soon as it applies in the catalog.";
      break;
    }
    case "applied":
      title = count === 1 ? "A .ops cost on your listings changed" : `${count} .ops costs on your listings changed`;
      lead = `${count === 1 ? "This .ops cost changed" : `These ${count} .ops costs changed`} and orders are charged the new cost from now:`;
      closing = "Check the prices on your listings for these products.";
      break;
    case "updated":
      title = count === 1 ? "An announced .ops cost change was updated" : `${count} announced .ops cost changes were updated`;
      lead = `${count === 1 ? "A change" : `${count} changes`} announced earlier ${count === 1 ? "was" : "were"} updated:`;
      closing = "Nothing is charged before the date each change was announced for.";
      break;
  }
  const message = [lead, ...listed, ...remainder, "", closing].join("\n");
  return {
    title,
    message,
    payload: {
      kind: input.kind,
      changeCount: count,
      changes: rows.slice(0, COST_NOTICE_PAYLOAD_CHANGES).map((row) => ({
        logId: row.logId, entryId: row.entryId, productVariantId: row.productVariantId, variantSku: row.variantSku,
        variantName: row.variantName, productName: row.productName, eventType: row.eventType,
        fromCents: row.fromCents, toCents: row.toCents, effectiveAt: row.effectiveAt.toISOString(),
      })),
    },
  };
}

function describeRow(row: CostChangeNoticeLogRow, kind: CostChangeNoticeKind): string {
  const label = `${row.variantSku?.trim() || row.variantName} (${row.productName})`;
  const money = (cents: number) => formatNotificationCurrency(cents, COST_NOTICE_CURRENCY);
  const date = formatNotificationDate(row.effectiveAt);
  if (kind === "updated") {
    if (row.eventType === "change_withdrawn" && row.fromCents !== null) {
      return `${label}: the change to ${money(row.fromCents)} announced for ${date} was withdrawn`;
    }
    if (row.fromCents !== null && row.toCents !== null) {
      return `${label}: the increase announced for ${date} is now ${money(row.toCents)} instead of ${money(row.fromCents)}`;
    }
    return `${label}: the change announced for ${date} was updated`;
  }
  if (row.fromCents !== null && row.toCents !== null) {
    return `${label}: ${money(row.fromCents)} → ${money(row.toCents)}${kind === "announced" ? ` from ${date}` : ""}`;
  }
  return `${label}: ${row.toCents !== null ? money(row.toCents) : "changed"}`;
}

export function emptyDecisionCounts(): Record<CostChangeNoticeDecision, number> {
  return { sent: 0, skipped_baseline: 0, skipped_decrease: 0, skipped_below_minimum: 0, skipped_channels_off: 0, skipped_unannounced: 0 };
}

function emptyPassResult(): DropshipCostNoticePassResult {
  return { groupsProcessed: 0, groupsFailed: 0, groupsDeferred: 0, noticesSent: 0, rowsDecided: 0, decisions: emptyDecisionCounts() };
}

function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError("DROPSHIP_COST_CHANGE_INVALID_INPUT", "Dropship cost change notice input failed validation.", {
      classification: "permanent",
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })),
    });
  }
  return result.data;
}
