import fs from 'fs';

const file = 'c:/Users/owner/Echelon/server/modules/orders/orders.storage.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/orderItems\.orderId/g, 'orderItems.wmsOrderId');
code = code.replace(/item\.orderId/g, 'item.wmsOrderId');
code = code.replace(/orders\.shopifyOrderId/g, 'orders.externalOrderId');
code = code.replace(/order\.shopifyOrderId/g, 'order.externalOrderId');
code = code.replace(/shopifyOrderId/g, 'externalOrderId');
code = code.replace(/getOrderByShopifyId/g, 'getOrderByExternalId');

code = code.replace(/order\.sourceTableId/g, 'order.omsFulfillmentOrderId');
code = code.replace(/orders\.sourceTableId/g, 'orders.omsFulfillmentOrderId');
code = code.replace(/sourceTableId/g, 'omsFulfillmentOrderId');

code = code.replace(/\[\.\.\.new Set\(/g, 'Array.from(new Set(');
code = code.replace(/toUpperCase\(\)\)\n\s*\)\]/g, 'toUpperCase())\n    ))');

code = code.replace(/orderItems\.shopifyLineItemId/g, 'orderItems.omsOrderLineId');
code = code.replace(/shopifyLineItemId: string/g, 'omsOrderLineId: number');
code = code.replace(/shopifyLineItemId/g, 'omsOrderLineId');

code = code.replace(/orders\.exceptionAt/g, 'orders.heldAt');

fs.writeFileSync(file, code);
console.log('Fixed orders.storage.ts via Typescript script');
