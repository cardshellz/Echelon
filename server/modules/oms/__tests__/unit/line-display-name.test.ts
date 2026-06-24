import { describe, expect, it } from "vitest";

import {
  buildChannelLineDisplayName,
  chooseBestLineDisplayName,
} from "../../line-display-name";

describe("line display names", () => {
  it("prefers the channel-provided name because it is the buyer-facing line string", () => {
    expect(
      buildChannelLineDisplayName({
        name: "Armalope Envelope Single Pocket - Case of 750",
        title: "Armalope Envelope Single Pocket",
        variantTitle: "Case of 750",
      }),
    ).toBe("Armalope Envelope Single Pocket - Case of 750");
  });

  it("composes title and variant when the channel name is missing", () => {
    expect(
      buildChannelLineDisplayName({
        title: "Armalope Envelope Single Pocket",
        variantTitle: "Case of 750",
      }),
    ).toBe("Armalope Envelope Single Pocket - Case of 750");
  });

  it("does not append Shopify's default variant title", () => {
    expect(
      buildChannelLineDisplayName({
        title: "Donation to Wounded Warrior Project",
        variantTitle: "Default Title",
      }),
    ).toBe("Donation to Wounded Warrior Project");
  });

  it("keeps an existing richer display name when an update payload carries only the bare title", () => {
    expect(
      chooseBestLineDisplayName(
        "Armalope Envelope Single Pocket - Case of 750",
        "Armalope Envelope Single Pocket",
      ),
    ).toBe("Armalope Envelope Single Pocket - Case of 750");
  });
});
