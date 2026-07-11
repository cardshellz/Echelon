import { describe, expect, it } from "vitest";

import {
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
});
