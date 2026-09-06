/** A deep link selects only from the server's existing authorized queue. */
export function packingOrderSelection(search: string): number | null {
  const value = new URLSearchParams(search).get("orderId");
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null;
}
