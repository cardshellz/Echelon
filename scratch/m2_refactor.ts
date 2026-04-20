import fs from 'fs';
import path from 'path';

const files = [
  'client/src/pages/APInvoiceDetail.tsx',
  'client/src/pages/APInvoices.tsx',
  'client/src/pages/APPayments.tsx',
  'client/src/pages/CostDashboard.tsx',
  'client/src/pages/EbayChannelPage.tsx',
  'client/src/pages/InboundShipmentDetail.tsx',
  'client/src/pages/Orders.tsx',
  'client/src/pages/ProductDetail.tsx',
  'client/src/pages/PurchaseOrderDetail.tsx',
  'client/src/pages/Replenishment.tsx',
  'client/src/pages/Settings.tsx',
  'client/src/pages/Suppliers.tsx',
  'client/src/pages/vendor/VendorWallet.tsx'
];

for (const f of files) {
  const p = path.resolve(f);
  if (!fs.existsSync(p)) continue;
  let content = fs.readFileSync(p, 'utf8');
  const orig = content;

  // Replace Math.round(parseFloat(...) * 100) or parseFloat(...) * 100
  content = content.replace(/Math\.round\(\s*parseFloat\(([^)]+)\)\s*\*\s*100\s*\)/g, 'dollarsToCents($1)');
  content = content.replace(/parseFloat\(([^)]+)\)\s*\*\s*100/g, 'dollarsToCents($1)');

  if (content !== orig) {
    // Inject import at the top
    const importLine = 'import { dollarsToCents } from "@shared/utils/money";\n';
    content = importLine + content;
    fs.writeFileSync(p, content);
    console.log(`Refactored ${f}`);
  }
}
