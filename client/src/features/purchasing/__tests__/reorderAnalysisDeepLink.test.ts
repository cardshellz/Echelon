import { describe, expect, it } from "vitest";
import { reorderAnalysisSearchParams } from "../reorderAnalysisDeepLink";

describe("reorderAnalysisSearchParams", () => {
  it("uses the browser query when the router location omits search parameters", () => {
    const params = reorderAnalysisSearchParams(
      "/reorder-analysis",
      "?forecastAction=verify_recent_demand&recommendationId=324%3Aproduct%3A90",
    );

    expect(params.get("forecastAction")).toBe("verify_recent_demand");
    expect(params.get("recommendationId")).toBe("324:product:90");
  });

  it("prefers query parameters included by the router location", () => {
    const params = reorderAnalysisSearchParams(
      "/reorder-analysis?reviewQueue=skipped&recommendationId=201%3A2001%3A30",
      "?reviewQueue=quality_review_required",
    );

    expect(params.get("reviewQueue")).toBe("skipped");
    expect(params.get("recommendationId")).toBe("201:2001:30");
  });
});
