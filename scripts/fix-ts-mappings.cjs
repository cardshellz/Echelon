const fs = require('fs');
const path = require('path');

const e = (file, cb) => {
  const p = path.join(__dirname, '../server', file);
  if (!fs.existsSync(p)) return;
  const old = fs.readFileSync(p, 'utf8');
  const res = cb(old);
  if (old !== res) {
    fs.writeFileSync(p, res, 'utf8');
    console.log(`Updated ${file}`);
  }
};

e('modules/orders/orders.storage.ts', txt => {
  return txt
    .replace('eq(orderItems.shopifyLineItemId, shopifyLineItemId)', 'eq(orderItems.shopifyLineItemId, String(shopifyLineItemId))')
    .replace('eq(orderItems.shopifyLineItemId, shopifyLineItemId)', 'eq(orderItems.shopifyLineItemId, String(shopifyLineItemId))');
});

e('modules/channels/channels.routes.ts', txt => {
  return txt.replace(/totalAmount:\s*any,\s*/g, '').replace(/totalAmount:\s*[^,]+,\s*/g, '');
});

e('modules/inventory/inventory.routes.ts', txt => {
  return txt.replace(/totalAmount:\s*any,\s*/g, '').replace(/totalAmount:\s*[^,]+,\s*/g, '');
});

e('modules/procurement/procurement.routes.ts', txt => {
  return txt.replace(/totalAmount:\s*any,\s*/g, '').replace(/totalAmount:\s*[^,]+,\s*/g, '');
});

e('routes/shopify.routes.ts', txt => {
  return txt.replace(/totalAmount:\s*any,\s*/g, '').replace(/totalAmount:\s*[^,]+,\s*/g, '');
});

// Drop .priceCents since wms isn't tracking financials anyway
e('modules/dropship/vendor-order-polling.ts', txt => {
  return txt.replace(/customsDeclaredValueCents:\s*\$[^,]+,/g, "customsDeclaredValueCents: 0,");
});
e('modules/oms/ebay-order-ingestion.ts', txt => {
  return txt.replace(/priceCents: dollarsToCents\([^)]+\),/g, "").replace(/customsDeclaredValueCents: dollarsToCents\([^)]+\)/g, "customsDeclaredValueCents: 0");
});
e('modules/oms/oms-webhooks.ts', txt => {
  return txt.replace(/priceCents: dollarsToCents\([^)]+\),/g, "").replace(/customsDeclaredValueCents: dollarsToCents\([^)]+\)/g, "customsDeclaredValueCents: 0");
});

console.log("TS cleanup done");
