const fs = require('fs');
const path = require('path');

const file = (p, cb) => {
  const full = path.join(__dirname, '../server', p);
  if (!fs.existsSync(full)) return;
  const old = fs.readFileSync(full, 'utf8');
  let next = cb(old);
  if (old !== next) {
    fs.writeFileSync(full, next, 'utf8');
    console.log("Updated", p);
  }
};

file('modules/channels/channels.routes.ts', txt => txt.replace(/totalAmount:\s*[^,]+,\s*/gi, ''));
file('modules/oms/ebay-order-ingestion.ts', txt => txt.replace(/priceCents:\s*dollarsToCents[^,]+,\s*/gi, ''));
file('modules/oms/oms-webhooks.ts', txt => txt.replace(/priceCents:\s*dollarsToCents[^,]+,\s*/gi, ''));
file('routes/shopify.routes.ts', txt => txt.replace(/currency:\s*[^,]+,\s*/gi, ''));

// for Type 'string' is not assignable to type 'number' we probably have "0" instead of 0 or similar? 
file('modules/dropship/vendor-order-polling.ts', txt => txt.replace(/customsDeclaredValueCents:\s*"[^"]*",/g, 'customsDeclaredValueCents: 0,').replace(/customsDeclaredValueCents:\s*'[^']*',/g, 'customsDeclaredValueCents: 0,'));
file('modules/oms/ebay-order-ingestion.ts', txt => txt.replace(/customsDeclaredValueCents:\s*"[^"]*",/g, 'customsDeclaredValueCents: 0,').replace(/customsDeclaredValueCents:\s*'[^']*',/g, 'customsDeclaredValueCents: 0,'));
file('modules/oms/oms-webhooks.ts', txt => txt.replace(/customsDeclaredValueCents:\s*"[^"]*",/g, 'customsDeclaredValueCents: 0,').replace(/customsDeclaredValueCents:\s*'[^']*',/g, 'customsDeclaredValueCents: 0,'));

file('modules/oms/wms-sync.service.ts', txt => txt.replace(/wmsOrderId:\s*orderId/g, 'orderId: orderId').replace(/wmsOrderId:\s*wmsOrder\.id/g, 'orderId: wmsOrder.id'));

console.log("done");
