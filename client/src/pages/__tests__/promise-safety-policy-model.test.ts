import { describe, expect, it } from "vitest";

import type {
  PromiseSafetyAdminScope,
  PromiseSafetyPolicyHeadAdmin,
} from "@shared/types/inventory-promise-safety-admin";
import {
  initialPromiseSafetyPolicyForm,
  parsePromiseSafetyPolicyForm,
  policyHeadForScope,
  promiseSafetyScopeKey,
} from "../promise-safety-policy-model";

const HASH = "a".repeat(64);

describe("promise safety policy UI model", () => {
  it("uses exact business, SKU, and warehouse/SKU scope identities", () => {
    expect(promiseSafetyScopeKey({ scopeType: "business" })).toBe("business");
    expect(promiseSafetyScopeKey({
      scopeType: "network_variant",
      productVariantId: 101,
    })).toBe("network:variant:101");
    expect(promiseSafetyScopeKey({
      scopeType: "warehouse_variant",
      warehouseId: 7,
      productVariantId: 101,
    })).toBe("warehouse:7:variant:101");
  });

  it("rejects business inheritance and converts decimal days without floating-point rounding", () => {
    expect(parsePromiseSafetyPolicyForm({ scopeType: "business" }, {
      policyMode: "inherit",
      fixedUnits: "0",
      daysOfCover: "1",
      untrustedDemandFallbackUnits: "0",
    })).toMatchObject({ success: false });

    expect(parsePromiseSafetyPolicyForm({ scopeType: "business" }, {
      policyMode: "days_of_cover",
      fixedUnits: "0",
      daysOfCover: "2.125",
      untrustedDemandFallbackUnits: "9",
    })).toEqual({
      success: true,
      value: {
        policyMode: "days_of_cover",
        daysOfCoverMilliDays: 2_125,
        untrustedDemandFallbackUnits: 9,
        demandMethodVersion: "irreversible_consumption_v1_28d",
      },
    });
    expect(parsePromiseSafetyPolicyForm({ scopeType: "business" }, {
      policyMode: "days_of_cover",
      fixedUnits: "0",
      daysOfCover: "2.1251",
      untrustedDemandFallbackUnits: "9",
    })).toMatchObject({ success: false });
  });

  it("prefills a draft before an active policy and defaults a new override to inherit", () => {
    const scope: PromiseSafetyAdminScope = {
      scopeType: "network_variant",
      productVariantId: 101,
    };
    const head = policyHead(scope, {
      active: { policyMode: "fixed_units", fixedUnits: 5 },
      draft: { policyMode: "off" },
    });
    expect(initialPromiseSafetyPolicyForm(scope, head).policyMode).toBe("off");
    expect(initialPromiseSafetyPolicyForm(scope, null).policyMode).toBe("inherit");
    expect(policyHeadForScope([head], scope)).toBe(head);
  });
});

function policyHead(
  scope: PromiseSafetyAdminScope,
  values: {
    active: { policyMode: "fixed_units"; fixedUnits: number };
    draft: { policyMode: "off" };
  },
): PromiseSafetyPolicyHeadAdmin {
  const base = {
    policyId: 1,
    version: 1,
    lifecycleStatus: "sealed" as const,
    scope,
    definitionHash: HASH,
    changeReason: "test",
    createdBy: "operator",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
  return {
    scopeKey: promiseSafetyScopeKey(scope),
    revision: "2",
    activePolicy: { ...base, value: values.active },
    draftPolicy: {
      ...base,
      policyId: 2,
      version: 2,
      lifecycleStatus: "draft",
      value: values.draft,
    },
  };
}
