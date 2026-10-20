import { describe, expect, it } from "vitest";
import { bindApPaymentCommandIdentity, resolveApPaymentCommandIdentity } from "../../ap-payment-command-identity";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
const descriptor: FinancialCommandDescriptor = { actorType: "user", actorId: "actor-a", method: "POST", routeTemplate: "/api/ap-payments", resourceKey: "vendor:1", idempotencyKey: "saved-intent-key", requestHash: "a".repeat(64), commandName: "ap.payment.record", contractVersion: 1 };
describe("AP command request identity", () => {
  it.each([{ actorId: "actor-b" }, { resourceKey: "vendor:2" }, { routeTemplate: "/api/ap-payments/:id/void" }, { requestHash: "b".repeat(64) }])("shares key scope but rejects changed identity %j through its different digest", patch => {
    const original = bindApPaymentCommandIdentity(descriptor, "record_payment");
    const changed = bindApPaymentCommandIdentity({ ...descriptor, ...patch }, "record_payment");
    expect(changed).toMatchObject({ actorType: original.actorType, actorId: original.actorId, resourceKey: original.resourceKey, routeTemplate: original.routeTemplate, method: original.method, idempotencyKey: original.idempotencyKey });
    expect(changed.requestHash).not.toBe(original.requestHash);
  });
  it("includes operation in the protected identity", () => {
    expect(bindApPaymentCommandIdentity(descriptor, "void_payment").requestHash).not.toBe(bindApPaymentCommandIdentity(descriptor, "record_payment").requestHash);
  });
  it("recovers exact legacy identity in its original namespace", async () => {
    expect(await resolveApPaymentCommandIdentity(descriptor, "record_payment", async () => [descriptor])).toBe(descriptor);
  });
  it("fails closed when the saved key already belongs to another legacy operator or multiple historical requests", async () => {
    await expect(resolveApPaymentCommandIdentity({ ...descriptor, actorId: "actor-b" }, "record_payment", async () => [descriptor])).rejects.toMatchObject({ code: "AP_PAYMENT_LEGACY_KEY_REVIEW" });
    await expect(resolveApPaymentCommandIdentity(descriptor, "record_payment", async () => [descriptor, { ...descriptor, actorId: "actor-b" }])).rejects.toMatchObject({ code: "AP_PAYMENT_LEGACY_KEY_REVIEW" });
  });
});
