import { describe, expect, it } from "vitest";
import { poEmailDeliveryPresentation } from "../../po-email-delivery";

describe("PO email transport and document hold presentation", () => {
  it.each(["queued", "processing", "dead_letter"] as const)("does not describe held %s as queued or sending", (status) => {
    expect(poEmailDeliveryPresentation({ status, documentHoldReason: "LEGACY_DOCUMENT_UNVERIFIED" })).toMatchObject({
      label: "Held for document review", needsAttention: true, canReplay: false,
    });
  });
  it("preserves actual provider acceptance after an in-flight held attempt finishes", () => {
    const result = poEmailDeliveryPresentation({ status: "sent", documentHoldReason: "LEGACY_DOCUMENT_UNVERIFIED" });
    expect(result.label).toBe("Accepted by email provider");
    expect(result.description).toContain("Recipient delivery is not confirmed");
    expect(result.canReplay).toBe(false);
  });
  it("allows replay only for an unheld failed snapshot", () => {
    expect(poEmailDeliveryPresentation({ status: "dead_letter" }).canReplay).toBe(true);
    expect(poEmailDeliveryPresentation({ status: "partially_sent" }).canReplay).toBe(false);
    expect(poEmailDeliveryPresentation({ status: "sent" }).label).not.toBe("Delivered");
  });
  it("disables replay when provider acceptance was already recorded before local finalize failed (PWF-01)", () => {
    const result = poEmailDeliveryPresentation({
      status: "dead_letter",
      providerMessageId: "<provider-id@example.com>",
      lastErrorCode: "LOCAL_FINALIZE_FAILED_AFTER_SMTP_ACCEPT",
    });
    expect(result.needsAttention).toBe(true);
    expect(result.canReplay).toBe(false);
    expect(result.description).toContain("prevent duplicate purchase orders");
  });
  it("surfaces uncertain provider outcome warning before manual replay (PWF-01)", () => {
    const result = poEmailDeliveryPresentation({
      status: "dead_letter",
      lastErrorCode: "SMTP_OUTCOME_UNCERTAIN",
    });
    expect(result.label).toBe("Provider outcome uncertain");
    expect(result.needsAttention).toBe(true);
    expect(result.canReplay).toBe(true);
    expect(result.description).toContain("Verify with the supplier or email provider before replaying");
  });
});
