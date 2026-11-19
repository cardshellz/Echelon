import { describe, expect, it } from "vitest";
import { requireReturnsSuccess } from "../../../scripts/ci/require-returns-success.mjs";

const success = () => ({ preflight: { result: "success", outputs: { run: "true", matrix: JSON.stringify({ include: [{ shard: 1 }] }) } },
  "browser-shard": { result: "success" }, "workflow-acceptance": { result: "success" } });
describe("the Returns release check requires connected acceptance", () => {
  it("accepts the complete successful journey", () => { expect(() => requireReturnsSuccess(success())).not.toThrow(); });
  it.each(["browser-shard", "workflow-acceptance"] as const)("fails when %s fails even if the other suite passes", job => {
    const needs = success(); needs[job].result = "failure"; expect(() => requireReturnsSuccess(needs)).toThrow();
  });
  it("rejects a missing or unaccounted-for check", () => {
    const needs = success(); expect(() => requireReturnsSuccess({ ...needs, "unreviewed-job": { result: "success" } })).toThrow();
    expect(() => requireReturnsSuccess({ preflight: needs.preflight, "browser-shard": needs["browser-shard"] })).toThrow();
  });
  it("allows both suites to skip only after an explicit successful empty plan", () => {
    const needs = { preflight: { result: "success", outputs: { run: "false", matrix: JSON.stringify({ include: [] }) } },
      "browser-shard": { result: "skipped" }, "workflow-acceptance": { result: "skipped" } };
    expect(() => requireReturnsSuccess(needs)).not.toThrow();
    needs.preflight.outputs.matrix = JSON.stringify({ include: [{ shard: 1 }] });
    expect(() => requireReturnsSuccess(needs)).toThrow();
  });
});
