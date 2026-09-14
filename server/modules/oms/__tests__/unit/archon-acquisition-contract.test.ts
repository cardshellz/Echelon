import { describe, it, expect } from "vitest";
import { readStorefrontAcquisition } from "../../archon-acquisition-contract";

const touch = {
  occurredAt: "2026-09-13T10:00:00Z",
  source: "google",
  medium: "cpc",
  campaignId: "fall",
};
const attribute = (value: unknown) => ({
  note_attributes: [{ name: "__archon_acquisition_v1", value }],
});
describe("Archon-owned acquisition handoff contract", () => {
  it("preserves recorded timestamps and stable identities on replay without mutating input", () => {
    const raw = attribute(JSON.stringify([touch]));
    const before = JSON.stringify(raw);
    const expected = { status: "valid", touches: [touch] };
    expect(readStorefrontAcquisition(raw)).toEqual(expected);
    expect(readStorefrontAcquisition(raw)).toEqual(expected);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it("accepts the canonical array, legacy attribute, and a cleared attribute", () => {
    expect(
      readStorefrontAcquisition({ marketing_attribution: [touch] }),
    ).toEqual({ status: "valid", touches: [touch] });
    expect(
      readStorefrontAcquisition({
        note_attributes: [
          { name: "archon_acquisition_v1", value: JSON.stringify([touch]) },
        ],
      }),
    ).toEqual({ status: "valid", touches: [touch] });
    expect(readStorefrontAcquisition(attribute(""))).toEqual({
      status: "valid",
      touches: [],
    });
  });
  it("never manufactures historical attribution from undated checkout URLs", () => {
    expect(
      readStorefrontAcquisition({
        landing_site: "https://shop.test/?utm_source=google",
        referring_site: "https://google.com",
        created_at: "2026-09-13T10:00:00Z",
      }),
    ).toEqual({ status: "valid", touches: [] });
  });
  it.each([
    attribute("not JSON"),
    attribute("x".repeat(20001)),
    attribute(JSON.stringify(Array.from({ length: 21 }, () => touch))),
    { marketing_attribution: [{ source: "google" }] },
    {
      marketing_attribution: [{ ...touch, landingUrl: "javascript:alert(1)" }],
    },
    {
      marketing_attribution: [
        { ...touch, landingUrl: "https://user:password@shop.test" },
      ],
    },
    {
      marketing_attribution: [
        { ...touch, landingUrl: "https://shop.test/?gclid=x&aleid=y" },
      ],
    },
    {
      marketing_attribution: [
        { ...touch, landingUrl: "https://shop.test/?archon_partner=BAD" },
      ],
    },
    { marketing_attribution: [{ ...touch, arbitrary: "secret" }] },
    {
      note_attributes: [
        { name: "archon_acquisition_v1", value: "[]" },
        { name: "__archon_acquisition_v1", value: "[]" },
      ],
    },
  ])("returns a sanitized failure for invalid customer evidence %#", (raw) => {
    expect(readStorefrontAcquisition(raw)).toEqual({
      status: "invalid",
      code: "INVALID_MARKETING_ATTRIBUTION",
      touches: [],
    });
  });
  it("accepts the bounded maximum", () => {
    expect(
      readStorefrontAcquisition(
        attribute(JSON.stringify(Array.from({ length: 20 }, () => touch))),
      ),
    ).toEqual({
      status: "valid",
      touches: Array.from({ length: 20 }, () => touch),
    });
  });
});
