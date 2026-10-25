import { describe, expect, it } from "vitest";
import { channelMerchandiseDemandReduction, type ChannelMerchandiseDemandChange } from "../../domain/channel-merchandise-demand";

const initial: Readonly<ChannelMerchandiseDemandChange> = Object.freeze({
  warehouseQuantity: 25, previousAuthorityQuantity: 25, currentAuthorityQuantity: 0,
  pickedQuantity: 0, fulfilledQuantity: 0,
});

describe("channel merchandise demand reduction", () => {
  it("releases unconsumed demand even when a shortage record retains its historical quantity", () => {
    expect(channelMerchandiseDemandReduction(initial)).toBe(25);
  });
  it.each([
    [{ currentAuthorityQuantity: 25 }, 0],
    [{ previousAuthorityQuantity: 0 }, 0],
    [{ warehouseQuantity: 0 }, 0],
    [{ pickedQuantity: 5 }, 20],
    [{ fulfilledQuantity: 25 }, 0],
    [{ pickedQuantity: 5, fulfilledQuantity: 3, currentAuthorityQuantity: 10 }, 15],
    [{ currentAuthorityQuantity: 30 }, 0],
    [{ warehouseQuantity: 2_147_483_647, previousAuthorityQuantity: 2_147_483_647 }, 2_147_483_647],
  ] as const)("keeps physical consumption and existing demand separate: %j", (patch, expected) => {
    expect(channelMerchandiseDemandReduction({ ...initial, ...patch })).toBe(expected);
  });
  it.each(["warehouseQuantity", "previousAuthorityQuantity", "currentAuthorityQuantity", "pickedQuantity", "fulfilledQuantity"] as const)(
    "validates %s before deriving a release", field => {
      for (const value of [-1, 0.5, Number.NaN, 2_147_483_648])
        expect(() => channelMerchandiseDemandReduction({ ...initial, [field]: value }))
          .toThrow(expect.objectContaining({ code: "CHANNEL_MERCHANDISE_DEMAND_INVALID" }));
    },
  );
});
