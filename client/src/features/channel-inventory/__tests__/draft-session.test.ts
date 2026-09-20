import { describe, expect, it } from "vitest";
import { canReplaceDraftBaseline, isDefinitiveDraftRejection } from "../draft-session";

describe("channel draft revision and uncertain-outcome boundaries", () => {
  it.each([null, 408, 500, 502, 503, 504])("retains the exact request after ambiguous status %s", status => {
    expect(isDefinitiveDraftRejection(status)).toBe(false);
  });
  it.each([400, 401, 403, 404, 409, 422, 429])("permits correction after a definitive rejection %s", status => {
    expect(isDefinitiveDraftRejection(status)).toBe(true);
  });
  it.each(["saving", "uncertain", "conflict"] as const)("never refreshes a %s draft baseline", saveState => {
    expect(canReplaceDraftBaseline({ dirty: false, saveState })).toBe(false);
    expect(canReplaceDraftBaseline({ dirty: true, saveState })).toBe(false);
  });
  it("refreshes only a pristine idle editor", () => {
    expect(canReplaceDraftBaseline({ dirty: false, saveState: "idle" })).toBe(true);
    expect(canReplaceDraftBaseline({ dirty: true, saveState: "idle" })).toBe(false);
  });
});
