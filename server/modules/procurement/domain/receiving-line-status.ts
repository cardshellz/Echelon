/** Receipt progress uses the entered count against the current source expectation. */
export function receivingLineStatus(
  receivedQty: number,
  expectedQty: number,
): string {
  if (receivedQty === 0) return "pending";
  if (receivedQty < expectedQty) return "partial";
  if (receivedQty === expectedQty) return "complete";
  return "overage";
}
