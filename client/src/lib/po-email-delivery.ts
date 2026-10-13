/** Transport evidence is provider acceptance, not confirmation of recipient delivery. */
export interface PoEmailDeliveryState {
  status: "queued" | "processing" | "sent" | "partially_sent" | "dead_letter";
  documentHoldReason?: string | null;
}

export function poEmailDeliveryPresentation(delivery: PoEmailDeliveryState): {
  label: string;
  description: string;
  needsAttention: boolean;
  canReplay: boolean;
} {
  const held = Boolean(delivery.documentHoldReason);
  if (held && delivery.status !== "sent" && delivery.status !== "partially_sent") {
    return {
      label: "Held for document review",
      description: "This saved document cannot be sent or replayed. Review the current purchase order and create a new email request.",
      needsAttention: true,
      canReplay: false,
    };
  }
  const presentations = {
    queued: { label: "Queued", description: "The saved document is waiting for an email attempt.", needsAttention: false, canReplay: false },
    processing: { label: "Sending", description: "An email attempt is in progress. Provider acceptance is not yet recorded.", needsAttention: false, canReplay: false },
    sent: { label: "Accepted by email provider", description: "The email provider accepted the message. Recipient delivery is not confirmed.", needsAttention: false, canReplay: false },
    partially_sent: { label: "Partially accepted by provider", description: "The email provider accepted only some recipients. Review the recorded error before contacting the supplier.", needsAttention: true, canReplay: false },
    dead_letter: { label: "Needs attention", description: "Automatic attempts stopped. Review the recorded error before replaying the saved document.", needsAttention: true, canReplay: true },
  };
  const presentation = presentations[delivery.status];
  return held ? {
    ...presentation,
    description: presentation.description + " This document also has a recorded review hold; it cannot be replayed.",
    needsAttention: true,
    canReplay: false,
  } : presentation;
}
