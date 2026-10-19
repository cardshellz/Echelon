import { describe, expect, it } from "vitest";
import { ebayListingPhaseFromStage } from "../../ebay-listing-job-progress";

describe("publication rejection progress", () => {
  it("describes a recorded publication rejection as publication work", () => {
    expect(ebayListingPhaseFromStage("publication_rejected")).toBe("publish");
  });
  it("keeps prior-request inspection distinct from publication work", () => {
    expect(ebayListingPhaseFromStage("recover_prior_requests")).toBe("recover_prior_requests");
  });
});
