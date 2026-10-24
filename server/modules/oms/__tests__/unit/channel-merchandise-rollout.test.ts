import { describe, expect, it } from "vitest";
import { channelMerchandiseAuthorityChannels } from "../../channel-merchandise-rollout";

describe("channel merchandise activation", () => {
  it("does not activate a channel on deployment alone", () => {
    expect(channelMerchandiseAuthorityChannels({})).toEqual([]);
    expect(
      channelMerchandiseAuthorityChannels({
        OMS_CHANNEL_MERCHANDISE_AUTHORITY_ENABLED: "false",
      }),
    ).toEqual([]);
  });
  it("requires both explicit activation and scoped channel identities", () => {
    expect(() =>
      channelMerchandiseAuthorityChannels({
        OMS_CHANNEL_MERCHANDISE_AUTHORITY_ENABLED: "true",
      }),
    ).toThrow();
    expect(() =>
      channelMerchandiseAuthorityChannels({
        OMS_CHANNEL_MERCHANDISE_AUTHORITY_ENABLED: "yes",
      }),
    ).toThrow();
    expect(
      channelMerchandiseAuthorityChannels({
        OMS_CHANNEL_MERCHANDISE_AUTHORITY_ENABLED: "true",
        OMS_CHANNEL_MERCHANDISE_CHANNEL_IDS: "36, 37,36",
      }),
    ).toEqual([36, 37]);
  });
  it.each(["", "36,", "-1", "NaN", "1.5", "2147483648"])(
    "rejects invalid allowlist %s",
    (value) => {
      expect(() =>
        channelMerchandiseAuthorityChannels({
          OMS_CHANNEL_MERCHANDISE_AUTHORITY_ENABLED: "true",
          OMS_CHANNEL_MERCHANDISE_CHANNEL_IDS: value,
        }),
      ).toThrow();
    },
  );
});
