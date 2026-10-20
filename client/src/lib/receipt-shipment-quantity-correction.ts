import { canonicalJson } from "@shared/utils/canonical-json";
import {
  quantityCorrectionApprovalSchema,
  quantityCorrectionContextSchema,
  quantityCorrectionId,
  shipmentQuantityEditApprovalSchema,
  type QuantityCorrectionPurpose,
  type QuantityCorrectionContext,
} from "@shared/procurement/receipt-shipment-quantity-correction";
import {
  createFinancialCommandIntentStore,
  financialCommandFetchJson,
  FinancialCommandRequestError,
} from "./financial-command";

/** Suggest a full-delivery correction only after the user explicitly includes receipts.
 * Partial/multiple deliveries keep their saved quantities; typed overrides always win. */
export function receiptCorrectionDraft(
  source: Pick<QuantityCorrectionContext, "shippedPieces" | "receipts">,
  shippedPieces: string,
  overrides: Readonly<Record<number, string>>,
): Record<number, string> {
  const fullDelivery =
    source.receipts.length === 1 &&
    source.receipts[0].receivedPieces === source.shippedPieces;
  return Object.fromEntries(
    source.receipts.map((receipt) => [
      receipt.receiptLineId,
      overrides[receipt.receiptLineId] ??
        (fullDelivery ? shippedPieces : String(receipt.receivedPieces)),
    ]),
  );
}

export function createQuantityCorrectionClient(
  generateKey: () => string,
  purpose: QuantityCorrectionPurpose = "receipt",
) {
  const intent = createFinancialCommandIntentStore(generateKey);
  let pending: string | null = null;
  return {
    async approve(lineId: number, input: unknown) {
      quantityCorrectionId.parse(lineId);
      const receiptInput =
        purpose === "receipt"
          ? quantityCorrectionApprovalSchema.parse(input)
          : null;
      const body =
          receiptInput ?? shipmentQuantityEditApprovalSchema.parse(input),
        fingerprint = canonicalJson({ lineId, body });
      if (pending !== null && pending !== fingerprint)
        throw new FinancialCommandRequestError(
          "Retry the pending correction before changing its values.",
          {
            status: null,
            code: "QUANTITY_CORRECTION_PENDING",
            ambiguous: true,
            retryable: true,
          },
        );
      const key = intent.acquire({ lineId, body });
      pending = fingerprint;
      try {
        const raw = await financialCommandFetchJson(
          `/api/shipment-lines/${lineId}/${purpose === "shipment" ? "shipment-edit" : "quantity-correction"}`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": key,
            },
            body: JSON.stringify(body),
          },
        );
        const parsed = quantityCorrectionContextSchema.safeParse(raw);
        const saved = parsed.success ? parsed.data.history[0] : null;
        if (
          !parsed.success ||
          parsed.data.shipmentLineId !== lineId ||
          !saved ||
          saved.sourceVersion !== body.sourceVersion ||
          saved.reason !== body.reason ||
          saved.summary.shipmentPieces.after !== body.shippedPieces ||
          (receiptInput !== null &&
            receiptInput.receipts.some(
              (receipt) =>
                saved.summary.receipts.find(
                  (row) => row.receiptLineId === receipt.receiptLineId,
                )?.afterPieces !== receipt.receivedPieces,
            )) ||
          (purpose === "shipment" &&
            (saved.summary.purpose !== "shipment" ||
              saved.summary.receipts.some(
                (receipt) =>
                  receipt.afterPieces !== receipt.receivedPieces ||
                  receipt.afterPiecesPerUnit !== receipt.piecesPerUnit,
              )))
        )
          throw new FinancialCommandRequestError(
            "The saved correction could not be verified. Retry the same approval.",
            {
              status: 200,
              code: "QUANTITY_CORRECTION_RESPONSE",
              ambiguous: true,
              retryable: true,
            },
          );
        intent.complete(key);
        pending = null;
        return parsed.data;
      } catch (error) {
        intent.fail(key, error);
        if (
          !(error instanceof FinancialCommandRequestError) ||
          !error.ambiguous
        )
          pending = null;
        throw error;
      }
    },
  };
}
