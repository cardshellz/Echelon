import { describe, expect, it } from "vitest";

import {
  getControlTowerV2Sources,
  loadControlTowerV2Groups,
  parseControlTowerV2GroupKey,
  parseControlTowerV2QueueFilters,
} from "../../control-tower-v2.query";
import {
  ControlTowerRequestError,
  parsePositiveWorkItemId,
  parseWorkItemVersion,
} from "../../control-tower-v2.request";

describe("Control Tower V2 request validation", () => {
  it("uses bounded queue defaults", () => {
    expect(parseControlTowerV2QueueFilters({})).toEqual({
      view: "attention",
      domain: "all",
      severity: "all",
      ownerTeam: null,
      assignedUserId: null,
      search: "",
      limit: 50,
      cursor: null,
    });
  });

  it("rejects unsupported filters instead of silently widening the queue", () => {
    expect(() => parseControlTowerV2QueueFilters({ domain: "finance" })).toThrow(ControlTowerRequestError);
    expect(() => parseControlTowerV2QueueFilters({ view: "everything" })).toThrow("Unsupported Control Tower view");
    expect(() => parseControlTowerV2QueueFilters({ limit: "101" })).toThrow("limit must be between 1 and 100");
  });

  it("requires positive safe integer identities and optimistic versions", () => {
    expect(parsePositiveWorkItemId("42")).toBe(42);
    expect(parseWorkItemVersion(3)).toBe(3);
    expect(() => parsePositiveWorkItemId("0")).toThrow("valid work item id");
    expect(() => parseWorkItemVersion("abc")).toThrow("valid work item version");
  });

  it("validates bounded root-cause group keys", () => {
    expect(parseControlTowerV2GroupKey("inventory:level_lot_bucket_drift")).toBe("inventory:level_lot_bucket_drift");
    expect(() => parseControlTowerV2GroupKey("")).toThrow("valid root-cause group key");
    expect(() => parseControlTowerV2GroupKey("x".repeat(201))).toThrow("valid root-cause group key");
  });

  it("returns grouped root causes while preserving affected-record counts", async () => {
    const statements: string[] = [];
    const client = {
      query: async (text: string) => {
        statements.push(text);
        if (text.includes("WITH filtered AS")) {
          return { rows: [{
            group_key: "inventory:level_lot_bucket_drift",
            domain: "inventory",
            code: "level_lot_bucket_drift",
            title: "Level Lot Bucket Drift",
            summary: "Location totals differ from FIFO lots.",
            expected_state: "Location totals equal FIFO lots.",
            actual_state: "143 records differ.",
            recommended_action: "Review the owning inventory movements.",
            severity: "blocker",
            severity_rank: 0,
            urgency: "normal",
            effective_triage_status: "needs_attention",
            owner_team: "Warehouse",
            affected_records: "143",
            affected_entities: "140",
            recurrence_count: "3",
            worsened_count: "2",
            first_seen_at: "2026-07-01T00:00:00.000Z",
            last_seen_at: "2026-07-11T00:00:00.000Z",
            last_changed_at: "2026-07-10T00:00:00.000Z",
            response_due_at: null,
            sort_at: "2026-07-01T00:00:00.000Z",
            representative_id: "41",
            sample_entity_refs: ["SKU-1 at A-01"],
            source_names: ["inventory.integrity_findings"],
            age_minutes: 14_400,
          }] };
        }
        if (text.includes("attention_records")) {
          return { rows: [{ attention: "20", attention_records: "27715", in_progress: "0", in_progress_records: "0", waiting: "0", waiting_records: "0", resolved: "1", resolved_records: "8" }] };
        }
        if (text.includes("GROUP BY work_item.domain")) {
          return { rows: [{ domain: "inventory", group_count: "15", affected_records: "27709" }] };
        }
        return { rows: [{ group_count: "20", affected_records: "27715" }] };
      },
    };

    const result = await loadControlTowerV2Groups({
      client,
      filters: parseControlTowerV2QueueFilters({ limit: "50" }),
    });

    expect(result.totalGroups).toBe(20);
    expect(result.totalAffectedRecords).toBe(27_715);
    expect(result.groups[0]).toMatchObject({
      groupKey: "inventory:level_lot_bucket_drift",
      affectedRecords: 143,
      affectedEntities: 140,
      representativeId: 41,
    });
    expect(statements.every((text) => text.includes("system_control"))).toBe(true);
    expect(statements.some((text) => text.includes("COUNT(DISTINCT"))).toBe(true);
  });

  it("reports an active projection as refreshing and returns system controls separately", async () => {
    const client = {
      query: async (text: string) => {
        if (text.includes("DISTINCT ON (source_name)")) {
          return { rows: [{
            id: "run-1",
            source_name: "inventory_integrity",
            projector_version: 3,
            status: "running",
            complete_scan: false,
            started_at: new Date(),
            completed_at: null,
            duration_ms: null,
            rows_scanned: 0,
            rows_created: 0,
            rows_updated: 0,
            rows_resolved: 0,
            rows_failed: 0,
            source_watermark: null,
            error_code: null,
            error_message: null,
          }] };
        }
        if (text.includes("operator_open_count")) {
          return { rows: [{ source_namespace: "inventory.integrity_findings", operator_open_count: "12", control_gap_count: "5" }] };
        }
        return { rows: [{
          group_key: "inventory:inventory_level_constraint_gap",
          domain: "inventory",
          code: "inventory_level_constraint_gap",
          title: "Inventory Level Constraint Gap",
          summary: "A required database guard is missing.",
          severity: "blocker",
          affected_records: "4",
          first_seen_at: "2026-07-10T00:00:00.000Z",
          last_seen_at: "2026-07-11T00:00:00.000Z",
          last_changed_at: "2026-07-10T00:00:00.000Z",
        }] };
      },
    };

    const result = await getControlTowerV2Sources(client);
    expect(result.sources.find((source) => source.name === "inventory_integrity")).toMatchObject({
      status: "refreshing",
      openItemCount: 12,
      controlGapCount: 5,
    });
    expect(result.controlGaps).toEqual([expect.objectContaining({
      groupKey: "inventory:inventory_level_constraint_gap",
      affectedRecords: 4,
    })]);
  });
});
