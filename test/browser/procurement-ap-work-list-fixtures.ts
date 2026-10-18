export function invoiceListItem(value: Record<string, unknown>) {
  return { id: value.id, vendorId: value.vendorId ?? 2, invoiceNumber: value.invoiceNumber, ourReference: value.ourReference ?? null,
    vendorName: value.vendorName ?? "Test vendor", vendorCode: value.vendorCode ?? "TEST", status: value.status ?? "approved",
    invoiceDate: value.invoiceDate ?? null, dueDate: value.dueDate ?? null, invoicedAmountCents: value.invoicedAmountCents ?? 10000,
    paidAmountCents: value.paidAmountCents ?? 0, balanceCents: value.balanceCents ?? 10000, inboundShipmentId: value.inboundShipmentId ?? null,
    currency: value.currency ?? "USD", poNumbers: value.poNumbers ?? [] };
}
export function paymentListItem(value: Record<string, unknown>) {
  return { id: value.id, vendorId: value.vendorId ?? 2, paymentNumber: value.paymentNumber, vendorName: value.vendorName ?? "Test vendor",
    vendorCode: value.vendorCode ?? "TEST", paymentDate: value.paymentDate ?? "2026-10-01T12:00:00Z", paymentMethod: value.paymentMethod ?? "ach",
    referenceNumber: value.referenceNumber ?? null, checkNumber: value.checkNumber ?? null, totalAmountCents: value.totalAmountCents ?? 10000,
    currency: value.currency ?? "USD", status: value.status ?? "completed" };
}
export function workListPage<T>(items: T[], url: string) {
  const params = new URL(url).searchParams; const limit = Number(params.get("limit") ?? 50); const offset = Number(params.get("offset") ?? 0);
  const page = items.slice(offset, offset + limit);
  return { items: page, total: items.length, limit, offset, nextOffset: offset + page.length < items.length ? offset + page.length : null };
}
