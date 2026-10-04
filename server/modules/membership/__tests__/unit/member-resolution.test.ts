import { describe, expect, it } from "vitest";
import { decideMemberMatch, toMemberPlan } from "../../domain/member-resolution";

const CLUB_PLAN_ID = "5f966934-9ff2-4966-9e8f-d4292ca3290e";

describe("toMemberPlan", () => {
  it("reads a plan row as node-postgres returns it", () => {
    expect(toMemberPlan({ plan_id: CLUB_PLAN_ID, name: ".club", primary_color: "#2E86DE", priority_modifier: 50 }))
      .toEqual({ planId: CLUB_PLAN_ID, name: ".club", color: "#2E86DE", priorityModifier: 50 });
  });

  it("accepts zero and negative integer modifiers", () => {
    expect(toMemberPlan({ plan_id: "core", name: ".core", primary_color: null, priority_modifier: 0 })?.priorityModifier)
      .toBe(0);
    expect(toMemberPlan({ plan_id: "slow", name: "Slow", primary_color: null, priority_modifier: -5 })?.priorityModifier)
      .toBe(-5);
  });

  it("accepts an integer modifier sent as text", () => {
    expect(toMemberPlan({ plan_id: "ops", name: ".ops", primary_color: null, priority_modifier: "100" })?.priorityModifier)
      .toBe(100);
    expect(toMemberPlan({ plan_id: "slow", name: "Slow", primary_color: null, priority_modifier: "-5" })?.priorityModifier)
      .toBe(-5);
  });

  it("refuses a modifier that is not a safe integer", () => {
    for (const priority_modifier of [1.5, "1.5", "high", "", null, undefined, Number.NaN, Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1, "9007199254740993", true]) {
      expect(toMemberPlan({ plan_id: "x", name: "X", primary_color: null, priority_modifier })).toBeNull();
    }
  });

  it("refuses a row without a plan id", () => {
    for (const plan_id of [null, undefined, "", 7]) {
      expect(toMemberPlan({ plan_id, name: "X", primary_color: null, priority_modifier: 0 })).toBeNull();
    }
  });

  it("keeps a missing name or color as null rather than inventing one", () => {
    expect(toMemberPlan({ plan_id: "x", name: "", primary_color: undefined, priority_modifier: 0 }))
      .toEqual({ planId: "x", name: null, color: null, priorityModifier: 0 });
  });
});

describe("decideMemberMatch", () => {
  it("finds no member in no rows", () => {
    expect(decideMemberMatch([])).toEqual({ kind: "none" });
  });

  it("finds one member, also when both of its id forms matched", () => {
    expect(decideMemberMatch(["m-1"])).toEqual({ kind: "one", memberId: "m-1" });
    expect(decideMemberMatch(["m-1", "m-1"])).toEqual({ kind: "one", memberId: "m-1" });
  });

  it("never picks between two members; reports them in a stable order", () => {
    expect(decideMemberMatch(["m-2", "m-1", "m-2"])).toEqual({ kind: "ambiguous", memberIds: ["m-1", "m-2"] });
  });

  it("does not change the rows it was given", () => {
    const rows = Object.freeze(["m-2", "m-1"]);
    decideMemberMatch(rows);
    expect(rows).toEqual(["m-2", "m-1"]);
  });
});
