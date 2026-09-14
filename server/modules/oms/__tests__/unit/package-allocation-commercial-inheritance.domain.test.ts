import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { validateInheritedCommercialIntents } from "../../package-allocation-commercial-inheritance.domain";

function fixture() {
  const payload = {
    effectType: "commercial_fulfillment",
    subjectKey: "commercial:12",
    wmsShipmentItemId: 12,
    packageKey: null,
    quantity: 2,
  };
  const payloadHash = createHash("sha256")
    .update(canonicalJson(payload))
    .digest("hex");
  const intentKey = "allocation:group:commercial:12";
  const intent = { ...payload, intentKey, payloadHash, executable: false };
  return {
    state: {
      desiredEffectIntents: [intent],
      effectIntentEvidence: [{ intentKey, payloadHash }],
      sourceLines: [{ wmsShipmentItemId: 12, sourceQuantity: 2 }],
    },
    rows: [
      {
        intentId: "9",
        originPlanId: "8",
        originPlanVersion: 1,
        intentKey,
        payloadHash,
        payload,
        executable: false,
        sourceLineId: "7",
        packageBindingId: null,
        packageKey: null,
        sourceWmsShipmentItemId: 12,
        sourceQuantity: 2,
        quantity: 2,
      },
    ],
  };
}

describe("inherited commercial authority", () => {
  it("accepts only the unchanged prior effect and does not mutate evidence", () => {
    const value = fixture();
    const before = structuredClone(value);
    expect(
      validateInheritedCommercialIntents(value.state, 2, value.rows),
    ).toEqual(value.rows);
    expect(value).toEqual(before);
  });
  it("accepts one legacy effect plus exact package-scoped continuation up to source quantity", () => {
    const value = fixture();
    const continuationPayload = {
      effectType: "commercial_fulfillment" as const,
      subjectKey: "commercial:12:package:package-b",
      wmsShipmentItemId: 12,
      packageKey: "package-b",
      quantity: 1,
    };
    const continuationHash = createHash("sha256")
      .update(canonicalJson(continuationPayload))
      .digest("hex");
    value.state.desiredEffectIntents[0].quantity = 1;
    const legacyHash = createHash("sha256")
      .update(canonicalJson({
        effectType: "commercial_fulfillment",
        subjectKey: "commercial:12",
        wmsShipmentItemId: 12,
        packageKey: null,
        quantity: 1,
      }))
      .digest("hex");
    value.state.desiredEffectIntents[0].payloadHash = legacyHash;
    value.state.effectIntentEvidence[0].payloadHash = legacyHash;
    value.rows[0].payloadHash = legacyHash;
    value.rows[0].payload.quantity = 1;
    value.rows[0].quantity = 1;
    value.state.desiredEffectIntents.push({
      ...continuationPayload,
      intentKey: "allocation:group:commercial:12:package:package-b",
      payloadHash: continuationHash,
      executable: false,
    });
    value.state.effectIntentEvidence.push({
      intentKey: "allocation:group:commercial:12:package:package-b",
      payloadHash: continuationHash,
    });
    value.rows.push({
      ...value.rows[0],
      intentId: "10",
      originPlanId: "9",
      intentKey: "allocation:group:commercial:12:package:package-b",
      payloadHash: continuationHash,
      payload: continuationPayload,
      packageBindingId: "11",
      packageKey: "package-b",
      quantity: 1,
    });

    expect(validateInheritedCommercialIntents(value.state, 3, value.rows)).toEqual(value.rows);
  });
  it.each([
    [
      "current-version effect",
      (value: ReturnType<typeof fixture>) => {
        value.rows[0].originPlanVersion = 2;
      },
    ],
    [
      "changed quantity",
      (value: ReturnType<typeof fixture>) => {
        value.state.desiredEffectIntents[0].quantity = 1;
      },
    ],
    [
      "changed registered source",
      (value: ReturnType<typeof fixture>) => {
        value.state.sourceLines[0].sourceQuantity = 3;
      },
    ],
    [
      "removed effect",
      (value: ReturnType<typeof fixture>) => {
        value.state.desiredEffectIntents = [];
      },
    ],
    [
      "replacement effect",
      (value: ReturnType<typeof fixture>) => {
        value.state.desiredEffectIntents[0].intentKey = "replacement";
      },
    ],
    [
      "mismatched history hash",
      (value: ReturnType<typeof fixture>) => {
        value.state.effectIntentEvidence[0].payloadHash = "f".repeat(64);
      },
    ],
    [
      "changed persisted payload",
      (value: ReturnType<typeof fixture>) => {
        value.rows[0].payload.quantity = 1;
      },
    ],
    [
      "executable effect",
      (value: ReturnType<typeof fixture>) => {
        value.rows[0].executable = true;
      },
    ],
    [
      "duplicate effects",
      (value: ReturnType<typeof fixture>) => {
        value.rows.push({ ...value.rows[0] });
      },
    ],
    [
      "missing source",
      (value: ReturnType<typeof fixture>) => {
        value.state.sourceLines = [];
      },
    ],
    [
      "duplicate history",
      (value: ReturnType<typeof fixture>) => {
        value.state.effectIntentEvidence.push({
          ...value.state.effectIntentEvidence[0],
        });
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = fixture();
    mutate(value);
    expect(() =>
      validateInheritedCommercialIntents(value.state, 2, value.rows),
    ).toThrow();
  });
  it("rejects first-version and unsafe integer identities", () => {
    const value = fixture();
    expect(() =>
      validateInheritedCommercialIntents(value.state, 1, value.rows),
    ).toThrow();
    value.rows[0].sourceWmsShipmentItemId = 2_147_483_648;
    expect(() =>
      validateInheritedCommercialIntents(value.state, 2, value.rows),
    ).toThrow();
  });
});
