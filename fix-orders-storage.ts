const fs = require('fs');
const path = require('path');

const file = 'c:/Users/owner/Echelon/server/modules/orders/orders.storage.ts';
let code = fs.readFileSync(file, 'utf8');

// fix order_items foreign key
code = code.replace(/orderItems\.orderId/g, 'orderItems.wmsOrderId');
code = code.replace(/item\.orderId/g, 'item.wmsOrderId');

// fix shopifyOrderId
code = code.replace(/shopifyOrderId/g, 'externalOrderId');

// fix sourceTableId
code = code.replace(/order\.sourceTableId/g, 'order.omsFulfillmentOrderId');
code = code.replace(/orders\.sourceTableId/g, 'orders.omsFulfillmentOrderId');

// fix Set iteration error (Typescript es2015 downlevel map filter issue)
code = code.replace(/\[\.\.\.new Set\(/g, 'Array.from(new Set(');
code = code.replace(/toUpperCase\(\)\)\n\s*\)\]/g, 'toUpperCase())\n    ))');

// fix shopifyLineItemId -> omsOrderLineId
code = code.replace(/orderItems\.shopifyLineItemId/g, 'orderItems.omsOrderLineId');
code = code.replace(/shopifyLineItemId: string/g, 'omsOrderLineId: number');
code = code.replace(/shopifyLineItemId/g, 'omsOrderLineId');

// fix exceptionAt
code = code.replace(/orders\.exceptionAt/g, 'orders.heldAt');

// fix InsertOrder vs InsertWmsOrder in createOrderWithItems mappings
// externalOrderId check
code = code.replace(/existingByExternalId = await this\.getOrderByShopifyId\(order\.externalOrderId\);/g, 'existingByExternalId = await this.getOrderByOrderNumber(order.externalOrderId as string);');

fs.writeFileSync(file, code);
console.log('Fixed orders.storage.ts');
