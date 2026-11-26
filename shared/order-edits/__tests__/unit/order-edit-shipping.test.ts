import { describe, expect, it } from "vitest";
import {
  orderEditShippingChargeKey,
  orderEditShippingCharges,
  orderEditShippingRepricingSchema,
  orderEditShippingTitle,
} from "../../order-edit-shipping";

const service = {
  title: "Standard Shipping",
  code: "standard",
  source: "Echelon Shipping",
};
const group = (profile: number | null, gross: number, net: number) => ({
  deliveryProfileId:
    profile === null ? null : `gid://shopify/DeliveryProfile/${profile}`,
  ...service,
  grossCents: gross,
  discountCents: gross - net,
  netCents: net,
  discountLabels: gross > net ? ["Member free shipping"] : [],
});
/** Saved before delivery groups existed: one charge and no `groups`. */
const single = {
  ...service,
  grossCents: 799,
  discountCents: 799,
  netCents: 0,
  discountLabels: ["Member free shipping"],
};
const two = {
  ...service,
  grossCents: 2398,
  discountCents: 1199,
  netCents: 1199,
  discountLabels: ["Member free shipping"],
  groups: [group(1, 1199, 0), group(2, 1199, 1199)],
};

describe("order edit shipping repricing", () => {
  it("still reads a quote saved with one charge and treats it as one delivery charge", () => {
    expect(orderEditShippingRepricingSchema.parse(single)).toEqual(single);
    expect(orderEditShippingCharges(single)).toEqual([
      {
        title: service.title,
        grossCents: 799,
        discountCents: 799,
        netCents: 0,
        discountLabels: ["Member free shipping"],
      },
    ]);
  });
  it("reads one charge per delivery group", () => {
    expect(orderEditShippingRepricingSchema.parse(two)).toEqual(two);
    expect(
      orderEditShippingCharges(two).map((charge) => charge.netCents),
    ).toEqual([0, 1199]);
    // A restored original charge has no known delivery profile.
    expect(
      orderEditShippingRepricingSchema.safeParse({
        ...two,
        groups: [group(null, 1199, 0), group(null, 1199, 1199)],
      }).success,
    ).toBe(true);
  });
  it.each([
    ["a single group, which has its own representation", [group(1, 2398, 1199)]],
    ["groups that do not add up to the charge", [group(1, 1199, 0), group(2, 1199, 1198)]],
    ["groups that do not add up to the rate", [group(1, 1200, 0), group(2, 1199, 1199)]],
    ["a group whose own amounts do not reconcile", [group(1, 1199, 0), { ...group(2, 1199, 1199), discountCents: 1 }]],
    ["a fractional amount", [group(1, 1199, 0), { ...group(2, 1199, 1199), netCents: 1198.5 }]],
  ])("rejects %s", (_name, groups) => {
    expect(
      orderEditShippingRepricingSchema.safeParse({ ...two, groups }).success,
    ).toBe(false);
  });
  it("compares charges by service and amount, in any order", () => {
    const key = orderEditShippingChargeKey;
    const free = { title: service.title, netCents: 0 };
    const paid = { title: service.title, netCents: 1199 };
    expect(key([free, paid])).toBe(key([paid, free]));
    // The same total as one charge is not the same set of charges.
    expect(key([free, paid])).not.toBe(key([paid]));
    expect(key([paid, paid])).not.toBe(key([paid]));
    expect(key([paid])).not.toBe(key([{ ...paid, title: "Express" }]));
    expect(key([paid])).not.toBe(key([{ ...paid, netCents: 1200 }]));
  });
  it("names the order's delivery service once", () => {
    expect(orderEditShippingTitle([service.title, service.title])).toBe(
      service.title,
    );
    expect(orderEditShippingTitle(["Standard", "Freight"])).toBe(
      "Standard + Freight",
    );
  });
});
