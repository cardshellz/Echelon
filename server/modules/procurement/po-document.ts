/**
 * po-document.ts
 * Renders a self-contained HTML document for a purchase order.
 * Suitable for printing or embedding in an email.
 */

function fmtMoney(cents: number | null | undefined): string {
  if (cents == null) return "$0.00";
  const n = Number(cents) / 100;
  // Show sub-cent precision for unit costs — no rounding
  if (n !== parseFloat(n.toFixed(2))) {
    return `$${String(n)}`;
  }
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  try {
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return String(d);
  }
}

export interface PoDocumentData {
  po: any;
  lines: any[];
  vendor?: any;
  warehouse?: any;
  companyName?: string;
  companyAddress?: string;
  companyCity?: string;
  companyState?: string;
  companyPostalCode?: string;
  companyCountry?: string;
}

export function renderPoHtml(data: PoDocumentData): string {
  const { po, lines, vendor, warehouse, companyName, companyAddress, companyCity, companyState, companyPostalCode, companyCountry } = data;

  const companyDisplayName = companyName || "Your Company";
  const companyAddrLine1 = companyAddress || "";
  const companyAddrLine2 = [companyCity, companyState, companyPostalCode, companyCountry].filter(Boolean).join(", ");

  const vendorName = vendor?.name || po?.vendor?.name || `Vendor #${po?.vendorId}`;
  const vendorAddress = vendor?.address || po?.vendor?.address || "";
  const vendorCity = vendor?.city || po?.vendor?.city || "";
  const vendorState = vendor?.state || po?.vendor?.state || "";
  const vendorPostal = vendor?.postalCode || po?.vendor?.postalCode || "";
  const vendorCountry = vendor?.country || po?.vendor?.country || "";
  const vendorContact = vendor?.contactName || po?.vendor?.contactName || "";
  const vendorEmail = vendor?.email || po?.vendor?.email || "";
  const vendorPhone = vendor?.phone || po?.vendor?.phone || "";

  const warehouseName = warehouse?.name || po?.warehouse?.name || "";
  const warehouseAddress = warehouse?.address || po?.warehouse?.address || "";
  const warehouseCity = warehouse?.city || po?.warehouse?.city || "";
  const warehouseState = warehouse?.state || po?.warehouse?.state || "";
  const warehousePostal = warehouse?.postalCode || po?.warehouse?.postalCode || "";
  const warehouseCountry = warehouse?.country || po?.warehouse?.country || "";

  const hasDiscount = po?.discountCents && Number(po.discountCents) > 0;
  const hasTax = po?.taxCents && Number(po.taxCents) > 0;
  const hasShipping = po?.shippingCents && Number(po.shippingCents) > 0;
  const hasVendorNotes = po?.vendorNotes && po.vendorNotes.trim();
  const hasInternalNotes = po?.internalNotes && po.internalNotes.trim();

  const lineRows = lines.map((line: any, idx: number) => {
    const sku = line.variant?.sku || line.sku || "—";
    const description = line.description || line.product?.name || line.variant?.name || "—";
    const qty = Number(line.orderQty ?? 0);
    const uom = line.uom || (line.unitsPerUom > 1 ? `CASE/${line.unitsPerUom}` : "EA");
    const unitCost = line.unitCostCents;
    const lineTotal = line.lineTotalCents ?? (unitCost * qty);
    return `
      <tr>
        <td style="text-align:center;color:#6b7280;">${idx + 1}</td>
        <td style="font-family:monospace;font-size:12px;">${esc(sku)}</td>
        <td>${esc(description)}</td>
        <td style="text-align:right;">${qty.toLocaleString()}</td>
        <td style="text-align:center;color:#6b7280;">${esc(uom)}</td>
        <td style="text-align:right;font-family:monospace;">${fmtMoney(unitCost)}</td>
        <td style="text-align:right;font-family:monospace;font-weight:600;">${fmtMoney(lineTotal)}</td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Purchase Order ${esc(po?.poNumber || "")}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 13px; color: #111; background: #fff; }
  .page { max-width: 800px; margin: 0 auto; padding: 32px 24px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; border-bottom: 2px solid #111; padding-bottom: 20px; }
  .company-block h1 { font-size: 22px; font-weight: 700; }
  .company-block p { font-size: 12px; color: #555; line-height: 1.5; }
  .po-title { text-align: right; }
  .po-title h2 { font-size: 26px; font-weight: 800; letter-spacing: 1px; color: #111; }
  .po-title .po-number { font-size: 15px; font-family: monospace; color: #374151; margin-top: 4px; }
  .po-title .po-date { font-size: 12px; color: #6b7280; margin-top: 2px; }
  .addresses { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
  .address-block h3 { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #6b7280; margin-bottom: 6px; }
  .address-block p { font-size: 13px; line-height: 1.6; }
  .address-block .contact { font-size: 12px; color: #6b7280; margin-top: 4px; }
  .details-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; margin-bottom: 24px; }
  .detail-cell h4 { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; margin-bottom: 3px; }
  .detail-cell p { font-size: 13px; font-weight: 500; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  thead th { background: #111; color: #fff; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; padding: 10px 12px; text-align: left; }
  tbody td { padding: 9px 12px; border-bottom: 1px solid #e5e7eb; vertical-align: middle; font-size: 13px; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:nth-child(even) { background: #f9fafb; }
  .totals { display: flex; justify-content: flex-end; margin-bottom: 24px; }
  .totals-table { min-width: 260px; }
  .totals-table td { padding: 5px 12px; font-size: 13px; }
  .totals-table td:first-child { color: #6b7280; }
  .totals-table td:last-child { text-align: right; font-family: monospace; font-weight: 500; }
  .totals-table .grand-total td { border-top: 2px solid #111; font-size: 15px; font-weight: 700; padding-top: 8px; }
  .totals-table .grand-total td:first-child { color: #111; }
  .notes { margin-bottom: 24px; }
  .notes h3 { font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; color: #6b7280; margin-bottom: 6px; }
  .notes p { font-size: 13px; line-height: 1.6; white-space: pre-wrap; border: 1px solid #e5e7eb; border-radius: 4px; padding: 10px 12px; background: #f9fafb; }
  .footer { border-top: 1px solid #e5e7eb; padding-top: 16px; font-size: 11px; color: #9ca3af; text-align: center; }
  @media print {
    body { font-size: 12px; }
    .page { padding: 16px; }
    .no-print { display: none; }
    @page { margin: 1cm; }
  }
</style>
</head>
<body>
<div class="page">
  <!-- Header -->
  <div class="header">
    <div class="company-block">
      <h1>${esc(companyDisplayName)}</h1>
      ${companyAddrLine1 ? `<p>${esc(companyAddrLine1)}</p>` : ""}
      ${companyAddrLine2 ? `<p>${esc(companyAddrLine2)}</p>` : ""}
    </div>
    <div class="po-title">
      <h2>PURCHASE ORDER</h2>
      <div class="po-number">${esc(po?.poNumber || "")}</div>
      <div class="po-date">Date: ${fmtDate(po?.orderDate || po?.createdAt)}</div>
    </div>
  </div>

  <!-- Addresses -->
  <div class="addresses">
    <div class="address-block">
      <h3>Vendor</h3>
      <p><strong>${esc(vendorName)}</strong></p>
      ${vendorAddress ? `<p>${esc(vendorAddress)}</p>` : ""}
      ${[vendorCity, vendorState, vendorPostal, vendorCountry].filter(Boolean).join(", ") ? `<p>${esc([vendorCity, vendorState, vendorPostal, vendorCountry].filter(Boolean).join(", "))}</p>` : ""}
      ${vendorContact || vendorEmail || vendorPhone ? `<div class="contact">
        ${vendorContact ? `<span>${esc(vendorContact)}</span>` : ""}
        ${vendorEmail ? `<span> · ${esc(vendorEmail)}</span>` : ""}
        ${vendorPhone ? `<span> · ${esc(vendorPhone)}</span>` : ""}
      </div>` : ""}
    </div>
    <div class="address-block">
      <h3>Ship To</h3>
      ${warehouseName ? `<p><strong>${esc(warehouseName)}</strong></p>` : `<p><strong>${esc(companyDisplayName)}</strong></p>`}
      ${warehouseAddress ? `<p>${esc(warehouseAddress)}</p>` : companyAddrLine1 ? `<p>${esc(companyAddrLine1)}</p>` : ""}
      ${[warehouseCity, warehouseState, warehousePostal, warehouseCountry].filter(Boolean).join(", ") ? `<p>${esc([warehouseCity, warehouseState, warehousePostal, warehouseCountry].filter(Boolean).join(", "))}</p>` : companyAddrLine2 ? `<p>${esc(companyAddrLine2)}</p>` : ""}
    </div>
  </div>

  <!-- PO Details Row -->
  <div class="details-row">
    <div class="detail-cell">
      <h4>Order Date</h4>
      <p>${fmtDate(po?.orderDate || po?.createdAt)}</p>
    </div>
    <div class="detail-cell">
      <h4>Expected Delivery</h4>
      <p>${fmtDate(po?.expectedDeliveryDate)}</p>
    </div>
    <div class="detail-cell">
      <h4>Payment Terms</h4>
      <p>${po?.paymentTerms ? esc(po.paymentTerms) : "—"}</p>
    </div>
    <div class="detail-cell">
      <h4>Incoterms</h4>
      <p>${po?.incoterms ? esc(po.incoterms) : "—"}</p>
    </div>
    <div class="detail-cell">
      <h4>Currency</h4>
      <p>${po?.currency ? esc(po.currency) : "USD"}</p>
    </div>
  </div>

  <!-- Line Items -->
  <table>
    <thead>
      <tr>
        <th style="width:40px;text-align:center;">#</th>
        <th style="width:110px;">SKU</th>
        <th>Description</th>
        <th style="width:70px;text-align:right;">Qty</th>
        <th style="width:70px;text-align:center;">UOM</th>
        <th style="width:100px;text-align:right;">Unit Cost</th>
        <th style="width:110px;text-align:right;">Line Total</th>
      </tr>
    </thead>
    <tbody>
      ${lineRows || '<tr><td colspan="7" style="text-align:center;color:#6b7280;padding:24px;">No line items</td></tr>'}
    </tbody>
  </table>

  <!-- Totals -->
  <div class="totals">
    <table class="totals-table">
      <tbody>
        <tr><td>Subtotal</td><td>${fmtMoney(po?.subtotalCents)}</td></tr>
        ${hasDiscount ? `<tr><td>Discount</td><td style="color:#16a34a;">−${fmtMoney(po?.discountCents)}</td></tr>` : ""}
        ${hasTax ? `<tr><td>Tax</td><td>${fmtMoney(po?.taxCents)}</td></tr>` : ""}
        ${hasShipping ? `<tr><td>Shipping</td><td>${fmtMoney(po?.shippingCents)}</td></tr>` : ""}
        <tr class="grand-total">
          <td>Grand Total</td>
          <td>${fmtMoney(po?.grandTotalCents)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  ${hasVendorNotes ? `
  <div class="notes">
    <h3>Notes to Vendor</h3>
    <p>${esc(po.vendorNotes)}</p>
  </div>` : ""}

  ${hasInternalNotes ? `
  <div class="notes">
    <h3>Internal Notes</h3>
    <p style="color:#6b7280;">${esc(po.internalNotes)}</p>
  </div>` : ""}

  <!-- Footer -->
  <div class="footer">
    <p>This is an official purchase order from ${esc(companyDisplayName)}. Please confirm receipt of this order and advise of any discrepancies.</p>
  </div>
</div>
</body>
</html>`;
}

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
