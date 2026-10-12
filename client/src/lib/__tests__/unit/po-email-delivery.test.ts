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
});
