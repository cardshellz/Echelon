const fs = require('fs');
const path = require('path');

function rep(file, oldStr, newStr) {
    const fullPath = path.join(__dirname, file);
    if (!fs.existsSync(fullPath)) return;
    const c = fs.readFileSync(fullPath, 'utf-8');
    fs.writeFileSync(fullPath, c.split(oldStr).join(newStr), 'utf-8');
}

rep('server/modules/dropship/vendor-order-polling.ts', 'priority: "normal"', 'priority: 100');
rep('server/modules/oms/ebay-order-ingestion.ts', 'priority: "normal"', 'priority: 100');
rep('server/modules/oms/oms-webhooks.ts', 'priority: "normal"', 'priority: 100');

rep('server/modules/channels/channels.routes.ts', '&& order.totalAmount', '&& (order as any).totalAmount');
rep('server/modules/channels/channels.routes.ts', 'parseFloat(order.totalAmount)', 'parseFloat((order as any).totalAmount)');

rep('server/modules/inventory/inventory.routes.ts', 'financialStatus: o.financialStatus', 'financialStatus: (o as any).financialStatus');
rep('server/modules/inventory/inventory.routes.ts', 'totalAmount: o.totalAmount', 'totalAmount: (o as any).totalAmount');

rep('server/modules/oms/ebay-order-ingestion.ts', 'priceCents: lineItem.discountedPriceCents || lineItem.priceCents || 0,', '/* priceCents is oms */');

rep('server/modules/oms/oms-webhooks.ts', 'priceCents: Math.round(parseFloat(item.price || "0") * 100),', '/* priceCents is oms */');

rep('server/modules/procurement/procurement.routes.ts', 'shopifyOrderId: order.shopifyOrderId', 'shopifyOrderId: (order as any).shopifyOrderId');
rep('server/modules/procurement/procurement.routes.ts', 'totalAmount: order.totalAmount', 'totalAmount: (order as any).totalAmount');

rep('server/modules/orders/picking.service.ts', 'reason?: string;', 'reason: string;');

rep('server/routes/shopify.routes.ts', 'shopifyOrderId: rawOrder.id,', '/* shopifyOrderId */');
rep('server/routes/shopify.routes.ts', 'financialStatus: rawOrder.financial_status,', '/* financialStatus */');
rep('server/routes/shopify.routes.ts', 'shopifyFulfillmentStatus: rawOrder.fulfillment_status,', '/* shopifyFulfillmentStatus */');
rep('server/routes/shopify.routes.ts', 'totalAmount: rawOrder.total_price_cents ? String(rawOrder.total_price_cents / 100) : null,', '/* totalAmount */');
rep('server/routes/shopify.routes.ts', 'currency: rawOrder.currency,', '/* currency */');
rep('server/routes/shopify.routes.ts', 'shopifyCreatedAt: rawOrder.order_date || rawOrder.created_at || undefined,', '/* shopifyCreatedAt */');

console.log('done');
