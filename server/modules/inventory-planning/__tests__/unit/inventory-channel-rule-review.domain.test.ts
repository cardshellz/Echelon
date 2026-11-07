import { describe, expect, it } from "vitest";
import { classifyChannelRuleIssues, type ChannelRulePlanTarget } from "../../domain/inventory-channel-rule-review";

const missingLink = { code: "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING", message: "No listing link." };
const incomplete = { code: "CHANNEL_EXPOSURE_POLICY_INCOMPLETE", message: "Rule fields do not resolve." };
const noBinding = { code: "CHANNEL_SOURCE_BINDING_MISSING", message: "No warehouse binding." };
const projection = { code: "CANONICAL_ATP_PROJECTION_BLOCKED", message: "Conservative quantity used." };

function target(input: Partial<ChannelRulePlanTarget> & { rows?: ChannelRulePlanTarget["rows"] } = {}): ChannelRulePlanTarget {
  return { publicationTargetId: 1, channelName: "Shopify", blockers: [], rows: [], ...input };
}
function row(productVariantId: number, sku: string | null, blockers = [] as ChannelRulePlanTarget["rows"][number]["blockers"],
  warnings = [] as ChannelRulePlanTarget["rows"][number]["warnings"]) {
  return { productVariantId, sku, blockers, warnings };
}

describe("single channel rule review classification", () => {
  it("treats a problem present before and after the rule as existing, never blocking", () => {
    const unrelated = target({ publicationTargetId: 3, channelName: "eBay", rows: [row(22, "C1000", [missingLink])] });
    const result = classifyChannelRuleIssues([unrelated], [unrelated]);
    expect(result).toEqual({ introduced: [], existing: ["eBay / C1000: No listing link."], notices: [] });
  });

  it("blocks only on problems the rule itself creates", () => {
    const before = [target({ rows: [row(22, "C1000")] })];
    const after = [target({ rows: [row(22, "C1000", [incomplete])] })];
    expect(classifyChannelRuleIssues(before, after).introduced).toEqual(["Shopify / C1000: Rule fields do not resolve."]);
  });

  it("identifies problems by destination, SKU and code, not by wording", () => {
    const before = [target({ rows: [row(22, "C1000", [{ ...missingLink, message: "Old wording." }])] })];
    const after = [target({ rows: [row(22, "C1000", [missingLink])] })];
    expect(classifyChannelRuleIssues(before, after)).toMatchObject({ introduced: [], existing: ["Shopify / C1000: No listing link."] });
  });

  it("does not let the same code on another SKU or destination hide a new problem", () => {
    const before = [target({ rows: [row(21, "P25", [missingLink]), row(22, "C1000")] }), target({ publicationTargetId: 3, rows: [row(22, "C1000")] })];
    const after = [target({ rows: [row(21, "P25", [missingLink]), row(22, "C1000", [missingLink])] }),
      target({ publicationTargetId: 3, channelName: "eBay", blockers: [noBinding], rows: [row(22, "C1000")] })];
    const result = classifyChannelRuleIssues(before, after);
    expect(result.introduced).toEqual(["Shopify / C1000: No listing link.", "eBay: No warehouse binding."]);
    expect(result.existing).toEqual(["Shopify / P25: No listing link."]);
  });

  it("separates destination-level problems from row problems with the same code", () => {
    const before = [target({ rows: [row(22, "C1000", [noBinding])] })];
    const after = [target({ blockers: [noBinding], rows: [row(22, "C1000", [noBinding])] })];
    expect(classifyChannelRuleIssues(before, after).introduced).toEqual(["Shopify: No warehouse binding."]);
  });

  it("names a SKU without a code by its id and shows a shared message once", () => {
    const after = [target({ rows: [row(22, null, [incomplete])] }), target({ publicationTargetId: 2, rows: [row(22, null, [incomplete])] })];
    expect(classifyChannelRuleIssues([], after).introduced).toEqual(["Shopify / SKU #22: Rule fields do not resolve."]);
  });

  it("reports conservative-quantity warnings as notices that never block", () => {
    const planned = [target({ rows: [row(22, "C1000", [], [projection])] })];
    expect(classifyChannelRuleIssues([], planned)).toEqual({ introduced: [], existing: [], notices: ["Shopify / C1000: Conservative quantity used."] });
  });

  it("returns nothing for empty plans and is deterministic", () => {
    expect(classifyChannelRuleIssues([], [])).toEqual({ introduced: [], existing: [], notices: [] });
    const after = [target({ rows: [row(22, "C1000", [incomplete, missingLink])] })];
    expect(classifyChannelRuleIssues([], after)).toEqual(classifyChannelRuleIssues([], after));
  });
});
