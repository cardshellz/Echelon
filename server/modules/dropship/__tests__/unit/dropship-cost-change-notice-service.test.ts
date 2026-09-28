import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DROPSHIP_COST_CHANGE_POLICY, type DropshipCostChangePolicySettings } from "../../../../../shared/dropship/cost-change-policy";
import {
  COST_NOTICE_LISTED_CHANGES,
  DEFAULT_COST_NOTICE_GROUPS_PER_PASS,
  DropshipCostChangeNoticeService,
  buildCostChangeNotice,
  type CostChangeNoticeDecisionRecord,
  type CostChangeNoticeGroup,
  type CostChangeNoticeLogRow,
  type DropshipCostChangeNoticeRepository,
  type VendorCostChangeLogView,
  type VendorCostChangeView,
} from "../../application/dropship-cost-change-notice-service";
import type { DropshipLogEvent, DropshipNotificationSenderInput } from "../../application/dropship-ports";

const NOW = new Date("2026-09-28T16:05:00.000Z");
const READING = new Date("2026-09-28T16:00:00.000Z");
const IN_TWO_WEEKS = new Date("2026-10-13T00:00:00.000Z");

function row(logId: number, patch: Partial<CostChangeNoticeLogRow> = {}): CostChangeNoticeLogRow {
  return {
    logId, entryId: 100 + logId, vendorId: 5, productVariantId: 60 + logId, variantSku: `SKU-${logId}`, variantName: `Variant ${logId}`,
    productName: "Armor Envelope", eventType: "increase_announced", fromCents: 809, toCents: 999, effectiveAt: IN_TWO_WEEKS,
    observedAt: READING, recordedBy: "detection", policyId: 3, ...patch,
  };
}

class FakeRepository implements DropshipCostChangeNoticeRepository {
  groups: CostChangeNoticeGroup[] = [];
  rowsByGroup = new Map<string, CostChangeNoticeLogRow[]>();
  sentEntries = new Set<number>();
  recorded: CostChangeNoticeDecisionRecord[][] = [];
  failRecording = false;
  announced: VendorCostChangeView[] = [];
  recent: VendorCostChangeLogView[] = [];
  reads: unknown[] = [];

  group(vendorId: number, observedAt: Date, recordedBy: "detection" | "acceptance", rows: CostChangeNoticeLogRow[]) {
    this.groups.push({ vendorId, observedAt, recordedBy, firstLogId: rows[0]?.logId ?? 1, rowCount: rows.length });
    this.rowsByGroup.set(`${vendorId}:${observedAt.toISOString()}:${recordedBy}`, rows);
  }
  async listUnnoticedGroups(input: { limit: number }) { this.reads.push(input); return this.groups.slice(0, input.limit); }
  async loadGroupRows(group: Pick<CostChangeNoticeGroup, "vendorId" | "observedAt" | "recordedBy">) {
    return this.rowsByGroup.get(`${group.vendorId}:${group.observedAt.toISOString()}:${group.recordedBy}`) ?? [];
  }
  async listSentEntryIds(entryIds: readonly number[]) { return new Set(entryIds.filter((id) => this.sentEntries.has(id))); }
  async recordDecisions(records: readonly CostChangeNoticeDecisionRecord[]) {
    if (this.failRecording) throw new Error("record failed");
    this.recorded.push([...records]);
    for (const record of records) if (record.decision === "sent") this.sentEntries.add(record.entryId);
    return records.length;
  }
  async listVendorAnnouncedChanges(input: unknown) { this.reads.push(input); return this.announced; }
  async listVendorRecentChanges(input: unknown) { this.reads.push(input); return this.recent; }
}

class FakeSender {
  sent: DropshipNotificationSenderInput[] = [];
  failNext = false;
  async send(input: DropshipNotificationSenderInput) {
    if (this.failNext) { this.failNext = false; throw new Error("notification store down"); }
    this.sent.push(input);
  }
}

describe("DropshipCostChangeNoticeService", () => {
  let repository: FakeRepository;
  let sender: FakeSender;
  let settings: DropshipCostChangePolicySettings;
  let logs: Array<DropshipLogEvent & { level: string }>;
  let service: DropshipCostChangeNoticeService;

  beforeEach(() => {
    repository = new FakeRepository();
    sender = new FakeSender();
    settings = { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY };
    logs = [];
    service = new DropshipCostChangeNoticeService({
      repository,
      policy: { resolvePolicy: async () => ({ policyId: 3, settings }) },
      notificationSender: sender,
      vendorProvisioning: { provisionForMember: async (memberId) => ({ vendor: { vendorId: memberId === "member-5" ? 5 : 9 } }) },
      clock: { now: () => NOW },
      logger: {
        info: (event) => logs.push({ ...event, level: "info" }),
        warn: (event) => logs.push({ ...event, level: "warn" }),
        error: (event) => logs.push({ ...event, level: "error" }),
      },
    });
  });

  it("sends one notice per reading and kind, and records a decision for every row", async () => {
    repository.group(5, READING, "detection", [
      row(1),
      row(2, { eventType: "baseline", fromCents: null, toCents: 809 }),
      row(3, { eventType: "decrease_applied", fromCents: 809, toCents: 699, effectiveAt: READING }),
      row(4, { eventType: "increase_announced", fromCents: 809, toCents: 819 }),
    ]);
    settings.noticeMinimumChangeCents = 25;

    const result = await service.runNoticePass({ workerId: "w-1" });

    expect(result).toEqual({
      groupsProcessed: 1, groupsFailed: 0, groupsDeferred: 0, noticesSent: 2, rowsDecided: 4,
      decisions: { sent: 2, skipped_baseline: 1, skipped_decrease: 0, skipped_below_minimum: 1, skipped_channels_off: 0, skipped_unannounced: 0 },
    });
    expect(sender.sent.map((notice) => [notice.eventType, notice.idempotencyKey, notice.channels, notice.critical])).toEqual([
      ["dropship_cost_change_announced", "dropship-cost-change:5:announced:detection:2026-09-28T16:00:00.000Z", ["email", "in_app"], false],
      ["dropship_cost_change_applied", "dropship-cost-change:5:applied:detection:2026-09-28T16:00:00.000Z", ["email", "in_app"], false],
    ]);
    expect(sender.sent[0]).toMatchObject({
      vendorId: 5,
      title: "A .ops cost on your listings changes on October 13, 2026",
      payload: { kind: "announced", changeCount: 1, recordedBy: "detection", policyId: 3, workerId: "w-1" },
    });
    expect(sender.sent[0]!.message).toBe([
      "From October 13, 2026, this .ops cost changes:",
      "- SKU-1 (Armor Envelope): USD $8.09 → USD $9.99 from October 13, 2026",
      "",
      "Orders accepted before that date are charged the current cost.",
    ].join("\n"));
    expect(repository.recorded).toHaveLength(1);
    expect(repository.recorded[0]!.map((record) => [record.logId, record.decision, record.noticeKind, record.idempotencyKey !== null])).toEqual([
      [1, "sent", "announced", true],
      [2, "skipped_baseline", null, false],
      [3, "sent", "applied", true],
      [4, "skipped_below_minimum", null, false],
    ]);
    expect(repository.recorded[0]![0]).toMatchObject({ entryId: 101, vendorId: 5, productVariantId: 61, eventType: "increase_announced", policyId: 3, decidedAt: NOW });
    expect(logs.map((log) => log.code)).toEqual(["DROPSHIP_COST_CHANGE_NOTICE_PASS_COMPLETED"]);
  });

  it("groups a plan switch into one message that lists the first changes and counts the rest", async () => {
    const rows = Array.from({ length: COST_NOTICE_LISTED_CHANGES + 3 }, (_, index) => row(index + 1));
    repository.group(5, READING, "detection", rows);

    await service.runNoticePass({ workerId: "w-1" });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.title).toBe(`${COST_NOTICE_LISTED_CHANGES + 3} .ops costs on your listings change on October 13, 2026`);
    expect(sender.sent[0]!.message).toContain("- and 3 more");
    expect((sender.sent[0]!.message ?? "").split("\n").filter((line) => line.startsWith("- SKU-"))).toHaveLength(COST_NOTICE_LISTED_CHANGES);
    expect(((sender.sent[0]!.payload ?? {}) as { changes: unknown[] }).changes).toHaveLength(COST_NOTICE_LISTED_CHANGES + 3);
  });

  it("updates the vendor on a lowered or withdrawn change only when the announcement went out", async () => {
    repository.sentEntries.add(101);
    repository.group(5, READING, "acceptance", [
      row(1, { eventType: "increase_reduced", fromCents: 999, toCents: 899 }),
      row(2, { eventType: "change_withdrawn", fromCents: 999, toCents: null }),
    ]);

    const result = await service.runNoticePass({ workerId: "w-1" });

    expect(result.decisions).toMatchObject({ sent: 1, skipped_unannounced: 1 });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({ eventType: "dropship_cost_change_updated", idempotencyKey: "dropship-cost-change:5:updated:acceptance:2026-09-28T16:00:00.000Z" });
    expect(sender.sent[0]!.message).toContain("SKU-1 (Armor Envelope): the increase announced for October 13, 2026 is now USD $8.99 instead of USD $9.99");
  });

  it("honours the policy's channels and says how orders are charged when protection is off", async () => {
    settings.notifyByEmail = false;
    settings.priceProtection = false;
    repository.group(5, READING, "detection", [row(1)]);

    await service.runNoticePass({ workerId: "w-1" });

    expect(sender.sent[0]).toMatchObject({ channels: ["in_app"] });
    expect(sender.sent[0]!.message).toContain("Orders are charged the new cost as soon as it applies in the catalog.");
  });

  it("records skips without sending when every channel is off", async () => {
    settings.notifyByEmail = false;
    settings.notifyInPortal = false;
    repository.group(5, READING, "detection", [row(1)]);

    const result = await service.runNoticePass({ workerId: "w-1" });

    expect(sender.sent).toEqual([]);
    expect(result.decisions.skipped_channels_off).toBe(1);
    expect(repository.recorded[0]![0]).toMatchObject({ decision: "skipped_channels_off", idempotencyKey: null, noticeEventType: null });
  });

  it("leaves a group undecided when its notice cannot be sent, and moves on to the next group", async () => {
    repository.group(5, READING, "detection", [row(1)]);
    repository.group(6, READING, "detection", [row(2, { vendorId: 6 })]);
    sender.failNext = true;

    const result = await service.runNoticePass({ workerId: "w-1" });

    expect(result).toMatchObject({ groupsProcessed: 1, groupsFailed: 1, noticesSent: 1 });
    expect(repository.recorded).toHaveLength(1);
    expect(repository.recorded[0]![0]!.vendorId).toBe(6);
    expect(logs.find((log) => log.level === "warn")).toMatchObject({
      code: "DROPSHIP_COST_CHANGE_NOTICE_GROUP_FAILED",
      context: { vendorId: 5, classification: "transient", error: "notification store down" },
    });
  });

  it("holds a vendor's later readings back once one of its readings failed, so a withdrawal is never judged before its announcement", async () => {
    const LATER = new Date(READING.getTime() + 60_000);
    repository.group(5, READING, "detection", [row(1)]);
    repository.group(5, LATER, "acceptance", [row(2, { eventType: "change_withdrawn", entryId: 101, fromCents: 999, toCents: null, observedAt: LATER, recordedBy: "acceptance" })]);
    repository.group(6, READING, "detection", [row(3, { vendorId: 6 })]);
    sender.failNext = true;

    const first = await service.runNoticePass({ workerId: "w-1" });

    expect(first).toMatchObject({ groupsProcessed: 1, groupsFailed: 1, groupsDeferred: 1, noticesSent: 1 });
    expect(repository.recorded.flat().map((record) => record.vendorId)).toEqual([6]);

    // Next pass: the announcement goes out first, so the withdrawal is an update to it, not an unannounced change.
    repository.groups = repository.groups.filter((group) => group.vendorId === 5);
    const second = await service.runNoticePass({ workerId: "w-1" });

    expect(second).toMatchObject({ groupsProcessed: 2, groupsFailed: 0, groupsDeferred: 0, noticesSent: 2 });
    expect(sender.sent.slice(1).map((notice) => notice.eventType)).toEqual(["dropship_cost_change_announced", "dropship_cost_change_updated"]);
    expect(repository.recorded.flat().map((record) => [record.logId, record.decision, record.noticeKind])).toEqual([
      [3, "sent", "announced"], [1, "sent", "announced"], [2, "sent", "updated"],
    ]);
  });

  it("refuses to record a sent decision when no sender is wired", async () => {
    const silent = new DropshipCostChangeNoticeService({
      repository,
      policy: { resolvePolicy: async () => ({ policyId: 3, settings }) },
      vendorProvisioning: { provisionForMember: async () => ({ vendor: { vendorId: 5 } }) },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: (event) => logs.push({ ...event, level: "warn" }), error: () => undefined },
    });
    repository.group(5, READING, "detection", [row(1)]);
    const result = await silent.runNoticePass({ workerId: "w-1" });
    expect(result).toMatchObject({ groupsProcessed: 0, groupsFailed: 1 });
    expect(repository.recorded).toEqual([]);
    expect(logs[0]?.context).toMatchObject({ errorCode: "DROPSHIP_COST_CHANGE_NOTICE_SENDER_MISSING" });
  });

  it("does nothing, quietly, when nothing is waiting", async () => {
    const result = await service.runNoticePass({ workerId: "w-1" });
    expect(result).toMatchObject({ groupsProcessed: 0, noticesSent: 0, rowsDecided: 0 });
    expect(repository.reads).toEqual([{ limit: DEFAULT_COST_NOTICE_GROUPS_PER_PASS }]);
    expect(logs).toEqual([]);
  });

  it("refuses an invalid pass input", async () => {
    await expect(service.runNoticePass({ workerId: "" })).rejects.toMatchObject({ code: "DROPSHIP_COST_CHANGE_INVALID_INPUT" });
    await expect(service.runNoticePass({ workerId: "w-1", groupsPerPass: 0 })).rejects.toMatchObject({ code: "DROPSHIP_COST_CHANGE_INVALID_INPUT" });
    await expect(service.runNoticePass({ workerId: "w-1", surprise: 1 })).rejects.toMatchObject({ code: "DROPSHIP_COST_CHANGE_INVALID_INPUT" });
  });

  it("serves a member their own announced and recent changes with the policy's notice terms", async () => {
    repository.announced = [{
      entryId: 11, productVariantId: 66, variantSku: "SKU", variantName: "Pack", productName: "Armor", kind: "increase",
      fromCents: 809, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS, announcedAt: READING,
    }];
    const view = await service.getVendorViewForMember("member-5");
    expect(view).toEqual({
      announced: repository.announced,
      recent: [],
      policy: { increaseNoticeDays: 14, decreaseTiming: "immediate", priceProtection: true, notifyByEmail: true, notifyInPortal: true, notifyOnDecrease: true },
      generatedAt: NOW,
    });
    expect(repository.reads).toEqual([
      { vendorId: 5, now: NOW, limit: 200 },
      { vendorId: 5, since: new Date("2026-08-29T16:05:00.000Z"), limit: 200 },
    ]);
    await expect(service.getVendorViewForMember("")).rejects.toMatchObject({ code: "DROPSHIP_COST_CHANGE_INVALID_INPUT" });
    await expect(service.getVendorView(0)).rejects.toMatchObject({ code: "DROPSHIP_COST_CHANGE_INVALID_INPUT" });
  });
});

describe("buildCostChangeNotice", () => {
  it("words an applied change and a withdrawn one", () => {
    const applied = buildCostChangeNotice({ kind: "applied", rows: [row(1, { eventType: "decrease_applied", fromCents: 809, toCents: 699, effectiveAt: READING })], settings });
    expect(applied.title).toBe("A .ops cost on your listings changed");
    expect(applied.message).toBe([
      "This .ops cost changed and orders are charged the new cost from now:",
      "- SKU-1 (Armor Envelope): USD $8.09 → USD $6.99",
      "",
      "Check the prices on your listings for these products.",
    ].join("\n"));
    const withdrawn = buildCostChangeNotice({ kind: "updated", rows: [row(2, { eventType: "change_withdrawn", fromCents: 999, toCents: null })], settings });
    expect(withdrawn.title).toBe("An announced .ops cost change was updated");
    expect(withdrawn.message).toContain("- SKU-2 (Armor Envelope): the change to USD $9.99 announced for October 13, 2026 was withdrawn");
    expect(() => buildCostChangeNotice({ kind: "applied", rows: [], settings })).toThrow(RangeError);
  });

  it("falls back to the variant name when there is no SKU", () => {
    const notice = buildCostChangeNotice({ kind: "announced", rows: [row(1, { variantSku: null })], settings });
    expect(notice.message).toContain("- Variant 1 (Armor Envelope)");
  });
});

const settings = { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY };
