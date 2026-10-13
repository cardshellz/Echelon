/** Self-contained supplier HTML. Only the validated external DTO crosses this boundary. */
import { supplierPoDocumentSchema, type SupplierPoDocument } from "./supplier-po-document";

function esc(value: string | number | null | undefined): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Integer formatting preserves every cent/mill, including large/signed values. */
function money(value: number, scale: 100 | 10000 = 100): string {
  const amount = BigInt(value);
  const magnitude = amount < BigInt(0) ? -amount : amount;
  const divisor = BigInt(scale);
  const digits = scale === 100 ? 2 : 4;
  let fraction = (magnitude % divisor).toString().padStart(digits, "0");
  if (scale === 10000) fraction = fraction.replace(/0{1,2}$/, "");
  return `${amount < BigInt(0) ? "−" : ""}$${(magnitude / divisor).toLocaleString("en-US")}.${fraction}`;
}
function date(value: string | null): string {
  return value === null ? "Not recorded" : new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  }).format(new Date(value));
}
function address(value: SupplierPoDocument["vendor"]): string {
  return `<strong>${esc(value.name)}</strong>`
    + value.addressLines.map(line => `<div>${esc(line)}</div>`).join("")
    + (value.addressLines.length === 0 ? '<div class="muted">Address not recorded</div>' : "")
    + [value.contactName, value.email, value.phone].filter(Boolean).map(line => `<div class="muted">${esc(line)}</div>`).join("");
}
function lineRow(line: SupplierPoDocument["lines"][number]): string {
  const product = line.lineType === "product";
  const price = line.pricing.unitCostMills !== null ? `${money(line.pricing.unitCostMills, 10000)}<small>per ${esc(line.pricing.unitLabel === "pieces" ? "piece" : line.pricing.unitLabel)}</small>`
    : line.pricing.quotedTotalCents !== null ? `${money(line.pricing.quotedTotalCents)}<small>quoted goods total</small>`
      : '<span class="muted">Recorded total</span>';
  const components = product ? [
    `Goods ${money(line.productAmountCents)}`,
    ...(line.packagingCents !== 0 ? [`Packaging ${money(line.packagingCents)}`] : []),
    ...(line.discountCents !== 0 ? [`Discount −${money(line.discountCents)}`] : []),
    ...(line.taxCents !== 0 ? [`Tax ${money(line.taxCents)}`] : []),
  ].join(" · ") : "";
  return `<tr data-line-id="${line.id}">
    <td class="line-number">${line.lineNumber}</td>
    <td class="item"><strong>${esc(product ? line.productName || line.description || line.sku : line.description)}</strong>
      ${line.sku ? `<small>SKU ${esc(line.sku)}</small>` : ""}
      ${line.vendorSku ? `<small>Supplier SKU ${esc(line.vendorSku)}</small>` : ""}
      ${product && line.description && line.description !== line.productName ? `<div class="description">${esc(line.description)}</div>` : ""}
      ${!product ? `<small>${esc(line.lineType)}</small>` : ""}
      ${line.appliesToLineNumber !== null ? `<small>Applies to line ${line.appliesToLineNumber}</small>` : ""}
      ${components ? `<small>${esc(components)}</small>` : ""}
    </td>
    <td class="quantity">${line.pricing.quantity.toLocaleString("en-US")}<small>${esc(line.pricing.unitLabel)}</small>
      ${line.pricing.piecesPerPurchaseUom !== null ? `<small>${line.pricing.piecesPerPurchaseUom.toLocaleString("en-US")} pieces each<br>${line.quantityPieces.toLocaleString("en-US")} pieces total</small>` : ""}
    </td>
    <td class="price">${price}</td>
    <td class="amount">${money(line.totalCents)}</td>
  </tr>`;
}

export function renderPoHtml(input: SupplierPoDocument): string {
  const doc = supplierPoDocumentSchema.parse(input);
  const totals = doc.totals;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Purchase Order ${esc(doc.poNumber)} — ${esc(doc.purposeLabel)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; color: #17212c; background: #fff; font: 13px/1.5 Arial, sans-serif; }
  .page { max-width: 900px; margin: auto; padding: 32px; }
  h1,h2,h3,p { margin: 0; }
  .header { display: flex; justify-content: space-between; gap: 24px; padding-bottom: 22px; border-bottom: 2px solid #17212c; }
  .company { max-width: 48%; overflow-wrap: anywhere; }
  .company h1 { font-size: 21px; }
  .company p { color: #536170; }
  .identity { text-align: right; }
  .identity h2 { font-size: 23px; letter-spacing: .04em; }
  .number { font-size: 16px; font-weight: 700; }
  .muted,small { color: #536170; }
  small { display: block; font-size: 11px; font-weight: normal; }
  .notice { margin: 18px 0; padding: 12px 14px; background: #f1f5f9; border-left: 3px solid #536170; }
  .notice strong { display: block; font-size: 11px; letter-spacing: .06em; margin-bottom: 4px; }
  .addresses { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 22px 0; }
  .addresses section { white-space: pre-line; overflow-wrap: anywhere; }
  h3 { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #536170; margin-bottom: 6px; }
  .details { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 16px; padding: 14px 0; border-top: 1px solid #d8e0e8; border-bottom: 1px solid #d8e0e8; margin-bottom: 22px; }
  .details div { overflow-wrap: anywhere; }
  .table-wrap { width: 100%; overflow-x: auto; }
  .lines { width: 100%; min-width: 570px; border-collapse: collapse; table-layout: fixed; }
  .lines th { background: #17212c; color: #fff; font-size: 10px; text-align: left; padding: 10px 8px; text-transform: uppercase; letter-spacing: .03em; }
  .lines td { border-bottom: 1px solid #d8e0e8; padding: 12px 8px; vertical-align: top; overflow-wrap: anywhere; }
  .lines .line-number { width: 5%; color: #536170; }
  .lines .item { width: 39%; }
  .lines .quantity { width: 15%; text-align: right; }
  .lines .price { width: 20%; text-align: right; }
  .lines .amount { width: 21%; text-align: right; font-weight: 700; }
  .description { margin-top: 4px; white-space: pre-wrap; }
  .totals { width: 320px; max-width: 100%; margin: 20px 0 24px auto; border-collapse: collapse; break-inside: avoid; }
  .totals td { padding: 5px 0 5px 16px; }
  .totals td:last-child { text-align: right; white-space: nowrap; }
  .total td { padding-top: 12px; border-top: 2px solid #17212c; font-size: 16px; font-weight: 700; }
  .notes { border-top: 1px solid #d8e0e8; padding-top: 16px; margin-top: 20px; }
  .notes p { white-space: pre-wrap; overflow-wrap: anywhere; }
  footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #d8e0e8; color: #536170; font-size: 10px; overflow-wrap: anywhere; }
  @media(max-width:600px) { .page { padding: 16px; } .header { gap: 12px; } .company h1 { font-size: 17px; } .identity h2 { font-size: 16px; } .details { grid-template-columns: repeat(2,minmax(0,1fr)); } .addresses { gap: 16px; } }
  @media print { @page { margin: 14mm; } .page { max-width: none; padding: 0; } .table-wrap { overflow: visible; } .lines { min-width: 0; } thead { display: table-header-group; } tr { break-inside: avoid; page-break-inside: avoid; } .header,.notice,.addresses,.details,.totals { break-inside: avoid; } body { font-size: 11px; } .lines th,.lines td { padding: 8px 5px; } }
</style>
</head>
<body>
<main class="page">
  <header class="header">
    <div class="company"><h1>${esc(doc.company.name)}</h1>${doc.company.addressLines.map(line => `<p>${esc(line)}</p>`).join("")}</div>
    <div class="identity"><h2>PURCHASE ORDER</h2><p class="number">${esc(doc.poNumber)}</p><p>Revision ${doc.revisionNumber} · ${doc.currency}</p></div>
  </header>
  <aside class="notice"><strong>${esc(doc.purposeLabel)}</strong>${esc(doc.notice)}</aside>
  <div class="addresses"><section><h3>Supplier</h3>${address(doc.vendor)}</section><section><h3>Ship to</h3>${address(doc.shipTo)}</section></div>
  <div class="details">
    <div><h3>${doc.orderDate === null ? "Created" : "Order date"}</h3>${date(doc.orderDate ?? doc.createdAt)}</div>
    <div><h3>Expected delivery</h3>${date(doc.expectedDeliveryDate)}</div>
    <div><h3>Payment terms</h3>${esc(doc.paymentTerms ?? "Not recorded")}</div>
    <div><h3>Incoterms</h3>${esc(doc.incoterms ?? "Not recorded")}</div>
  </div>
  ${doc.referenceNumber ? `<p style="margin-bottom:12px">Supplier reference: ${esc(doc.referenceNumber)}</p>` : ""}
  <div class="table-wrap"><table class="lines" aria-label="Purchase order lines">
    <thead><tr><th class="line-number">#</th><th class="item">Item / terms</th><th class="quantity">Quantity</th><th class="price">Quoted price</th><th class="amount">Line total</th></tr></thead>
    <tbody>${doc.lines.map(lineRow).join("") || '<tr><td colspan="5">No active line items.</td></tr>'}</tbody>
  </table></div>
  <table class="totals" aria-label="Purchase order totals"><tbody>
    <tr><td>Line subtotal</td><td>${money(totals.subtotalCents)}</td></tr>
    ${totals.discountCents !== 0 ? `<tr><td>Order discount</td><td>−${money(totals.discountCents)}</td></tr>` : ""}
    ${totals.taxCents !== 0 ? `<tr><td>Order tax</td><td>${money(totals.taxCents)}</td></tr>` : ""}
    ${totals.shippingCents !== 0 ? `<tr><td>Shipping</td><td>${money(totals.shippingCents)}</td></tr>` : ""}
    <tr class="total"><td>Total ${doc.currency}</td><td>${money(totals.totalCents)}</td></tr>
  </tbody></table>
  ${doc.vendorNotes?.trim() ? `<section class="notes"><h3>Notes to supplier</h3><p>${esc(doc.vendorNotes)}</p></section>` : ""}
  <footer>PO ${esc(doc.poNumber)} · Revision ${doc.revisionNumber} · ${esc(doc.purposeLabel)}<br>Document reference: ${doc.sourceRevision}</footer>
</main>
</body>
</html>`;
}
