import { describe, expect, it } from "vitest";
import { verifyCustodyCommandResult, type CustodyAction, type VerifiedCustodyResult } from "@shared/procurement/receiving-quarantine-command";
import { custodyTestIntake, custodyTestResult } from "@shared/procurement/__tests__/receiving-quarantine.fixture";
const requests = {
  intake: custodyTestIntake,
  "prepare-acceptance": { expectedVersion: 0, observationQty: 2, targetReceivingOrderId: 7, targetSourceReceivingLineId: 5,
    expectedTargetUnitVersion: "a".repeat(64), productVariantId: 2, expectedUnitsPerVariant: 10, acceptedVariantQty: 3,
    purchaseOrderLineId: null, inboundShipmentLineId: null, putawayLocationId: 9, reason: "Reviewed acceptance", countConversionReviewed: true },
  return: { expectedVersion: 0, observationQty: 2, reason: "Supplier collection", evidenceReference: "RETURN-42" },
  "cancel-acceptance": { expectedVersion: 1, acceptanceId: 61, reason: "Review source again" },
};
function fixture(command: CustodyAction) {
  const identity = { command, resourceId: command === "intake" ? 7 : 9, actorId: "operator", idempotencyKey: "custody-result-test-key" };
  const request = requests[command];
  const result: VerifiedCustodyResult = { ...custodyTestResult(command, identity.resourceId, request, identity.actorId), ...identity, request };
  return { result, verify: () => verifyCustodyCommandResult(result, identity, request) };
}
describe("verified quarantine result contract", () => {
  it.each(Object.keys(requests) as CustodyAction[])("accepts complete recorded %s evidence", command => { const f = fixture(command); expect(f.verify()).toEqual(f.result); });
  const corruptions: Array<[CustodyAction, string, (result: VerifiedCustodyResult) => void]> = [
    ["intake", "unreconciled held balance", r => { r.observation.physicalHeldQty++; }],
    ["prepare-acceptance", "wrong revision", r => { r.observation.version++; }],
    ["prepare-acceptance", "missing disposition", r => { r.observation.dispositions = []; }],
    ["prepare-acceptance", "wrong disposition actor", r => { r.observation.dispositions[0].actorId = "another"; }],
    ["prepare-acceptance", "wrong disposition quantity", r => { r.observation.dispositions[0].observationQty++; }],
    ["prepare-acceptance", "different pack", r => { r.acceptance!.unitsPerVariant++; }],
    ["prepare-acceptance", "different accepted count", r => { r.acceptance!.acceptedVariantQty++; }],
    ["prepare-acceptance", "different target receipt", r => { r.acceptance!.receivingOrderId++; }],
    ["prepare-acceptance", "premature recognition", r => { r.acceptance!.status = "received"; }],
    ["return", "wrong physical return proof", r => { r.observation.dispositions[0].evidenceReference = "OTHER"; }],
    ["return", "wrong returned quantity", r => { r.observation.dispositions[0].observationQty++; }],
    ["cancel-acceptance", "different acceptance", r => { r.acceptance!.id++; }],
    ["cancel-acceptance", "unresolved acceptance", r => { r.acceptance!.status = "awaiting_receipt"; }],
  ];
  it.each(corruptions)("rejects %s evidence with %s", (command, _name, corrupt) => { const f = fixture(command); corrupt(f.result); expect(f.verify).toThrow(); });
});
