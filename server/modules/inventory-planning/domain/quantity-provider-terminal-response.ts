import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { createHash } from "node:crypto";

export const terminalRequestReceiptSchema = z
  .object({
    requestId: z.string().regex(/^[1-9][0-9]*$/),
    ordinal: z.number().int().positive(),
    method: z.enum(["PUT", "POST", "DELETE"]),
    path: z.string().min(1).max(1024),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["completed", "rejected", "uncertain"]).nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    responseHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    errorCodes: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(25),
    recordedAt: z.string().datetime().nullable(),
    requestTerminated: z.boolean().nullable().optional(),
  })
  .strict();
export type TerminalRequestReceipt = z.infer<
  typeof terminalRequestReceiptSchema
>;

/** eBay's REST error contract says processing stops on an errors response.
 * This proves request termination, NEVER rejection/no effect or historical success.
 * Only synchronous replace/quantity endpoints are supported. Missing responses,
 * 202, malformed/partial 2xx and gateway error pages cannot release a fence.
 * https://developer.ebay.com/develop/guides/sell/using-ebay-restful-apis
 */
export function terminalEbayResponseEvidence(
  input: unknown,
): { receipts: TerminalRequestReceipt[]; hash: string } | null {
  const parsed = z
    .array(terminalRequestReceiptSchema)
    .min(1)
    .max(2000)
    .safeParse(input);
  if (!parsed.success) return null;
  const receipts = parsed.data;
  if (
    receipts.some((row, index) => {
      const bulk = row.method === "POST" && row.path === "/sell/inventory/v1/bulk_update_price_quantity";
      const supported =
        (row.method === "PUT" &&
          /^\/sell\/inventory\/v1\/(inventory_item|inventory_item_group|offer)\/[^/?#\s]+$/.test(
            row.path,
          )) ||
        (row.method === "POST" &&
          row.path === "/sell/inventory/v1/bulk_update_price_quantity");
      const completed =
        row.outcome === "completed" &&
        [200, 201, 204].includes(row.httpStatus ?? 0) &&
        // Historical bulk writers treated HTTP 200 as completion without
        // validating each SKU/offer response. A body hash cannot reconstruct
        // those missing operation receipts. Only instrumented finality proves
        // bulk completion; legacy synchronous PUT success remains supported.
        (!bulk || row.requestTerminated === true);
      const instrumentedFinal = row.requestTerminated === true
        && row.outcome !== null && row.httpStatus !== null
        && ([200,201,204,207].includes(row.httpStatus) || (row.httpStatus >= 400 && row.httpStatus !== 408));
      // errorCodes are extracted ONLY from a validated top-level eBay errors array,
      // never inferred from status or arbitrary text (including historical receipts).
      const stopped =
        (row.outcome === "uncertain" || row.outcome === "rejected") &&
        (row.httpStatus ?? 0) >= 400 &&
        row.httpStatus !== 408 &&
        row.errorCodes.length > 0;
      return (
        !supported ||
        row.ordinal !== index + 1 ||
        !row.responseHash ||
        !row.recordedAt ||
        row.requestTerminated === false ||
        !(completed || stopped || instrumentedFinal)
      );
    }) ||
    new Set(receipts.map((row) => row.requestId)).size !== receipts.length
  )
    return null;
  return {
    receipts,
    hash: createHash("sha256").update(canonicalJson(receipts)).digest("hex"),
  };
}
