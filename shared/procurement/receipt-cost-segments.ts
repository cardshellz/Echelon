import { z } from "zod";
import { allocateIntegerCostInterval } from "../utils/integer-cost-interval";
const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.number().int().nonnegative().safe();
const money = z.number().int().nonnegative().safe();
/** A source interval, not a rounded unit price. Invoice offsets retain exact
 * cents when one invoice covers several receipts or one receipt has a remainder. */
export const receiptCostSegmentSchema = z
  .object({
    startBasePiece: quantity,
    pieces: quantity.positive(),
    receivingLineId: id.nullable(),
    invoiceLineId: id.nullable(),
    sourceStartPiece: quantity,
    sourceBasePieces: quantity.positive(),
    sourceTotalMills: money,
    evidence: z.enum(["estimated", "confirmed"]),
  })
  .strict()
  .superRefine((row, context) => {
    if (
      ![
        row.startBasePiece,
        row.pieces,
        row.sourceStartPiece,
        row.sourceBasePieces,
        row.sourceTotalMills,
      ].every(Number.isSafeInteger)
    )
      return;
    if (
      BigInt(row.sourceStartPiece) + BigInt(row.pieces) >
        BigInt(row.sourceBasePieces) ||
      BigInt(row.startBasePiece) + BigInt(row.pieces) >
        BigInt(Number.MAX_SAFE_INTEGER) ||
      (row.evidence === "confirmed"
        ? row.receivingLineId === null || row.invoiceLineId === null
        : row.receivingLineId !== null || row.invoiceLineId !== null)
    )
      context.addIssue({
        code: "custom",
        message:
          "The receipt interval must identify an exact supported source.",
      });
  });
export type ReceiptCostSegment = z.infer<typeof receiptCostSegmentSchema>;

/** Intersect frozen receipt/lot intervals with their selected sources. Never
 * multiply a displayed unit price back into inventory value. */
export function receiptSegmentCost(
  segments: readonly ReceiptCostSegment[],
  start: number,
  pieces: number,
  receivingLineId?: number,
) {
  quantity.parse(start);
  quantity.parse(pieces);
  const end = BigInt(start) + BigInt(pieces);
  let mills = BigInt(0),
    covered = BigInt(0),
    confirmed = BigInt(0),
    expected = BigInt(start);
  for (const segment of segments) {
    const row = receiptCostSegmentSchema.parse(segment);
    const left =
      BigInt(row.startBasePiece) > BigInt(start)
        ? BigInt(row.startBasePiece)
        : BigInt(start);
    const rightEnd = BigInt(row.startBasePiece) + BigInt(row.pieces);
    const right = rightEnd < end ? rightEnd : end;
    if (right <= left) continue;
    if (
      row.evidence === "confirmed" &&
      receivingLineId !== undefined &&
      row.receivingLineId !== receivingLineId
    )
      throw new RangeError(
        "The invoice allocation belongs to a different receipt line.",
      );
    if (left !== expected)
      throw new RangeError("Receipt cost intervals overlap or leave a gap.");
    expected = right;
    const count = right - left;
    mills += allocateIntegerCostInterval(
      BigInt(row.sourceTotalMills),
      BigInt(row.sourceBasePieces),
      BigInt(row.sourceStartPiece) + left - BigInt(row.startBasePiece),
      count,
    );
    covered += count;
    if (row.evidence === "confirmed") confirmed += count;
  }
  if (
    expected !== end ||
    covered !== BigInt(pieces) ||
    mills > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new RangeError(
      "The complete receipt interval has no exact supported source coverage.",
    );
  return {
    totalMills: Number(mills),
    confirmedPieces: Number(confirmed),
    provisionalPieces: pieces - Number(confirmed),
  };
}
