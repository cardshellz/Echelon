import os

file = 'server/modules/orders/orders.storage.ts'
with open(file, 'r', encoding='utf-8') as f:
    c = f.read()

# Fix wmsOrderId to orderId (I replaced wmsOrderItems as orderItems, so now orderItems expects orderId)
c = c.replace('wmsOrderId: newOrder.id', 'orderId: newOrder.id')
c = c.replace('wmsOrderId: o.wmsOrderId', 'orderId: o.orderId')
c = c.replace('item.wmsOrderId', 'item.orderId')

# Fix omsOrderLineId to shopifyLineItemId
c = c.replace('omsOrderLineId', 'shopifyLineItemId')

# Fix omsFulfillmentOrderId 
c = c.replace('omsFulfillmentOrderId', 'sourceTableId')

with open(file, 'w', encoding='utf-8') as f:
    f.write(c)

# Also fix the routes where omsFulfillmentOrderId was used
ch_file = 'server/modules/channels/channels.routes.ts'
with open(ch_file, 'r', encoding='utf-8') as f:
    ch = f.read()
ch = ch.replace('order.omsFulfillmentOrderId', 'order.sourceTableId')
with open(ch_file, 'w', encoding='utf-8') as f:
    f.write(ch)

wms_sync = 'server/modules/oms/wms-sync.service.ts'
with open(wms_sync, 'r', encoding='utf-8') as f:
    ws = f.read()
ws = ws.replace('wmsOrderId: orderId', 'orderId: orderId')
ws = ws.replace('wmsOrderId: order.id', 'orderId: order.id')
with open(wms_sync, 'w', encoding='utf-8') as f:
    f.write(ws)

sp_route = 'server/routes/shopify.routes.ts'
if os.path.exists(sp_route):
    with open(sp_route, 'r', encoding='utf-8') as f:
        sp = f.read()
    sp = sp.replace('omsFulfillmentOrderId:', 'sourceTableId:')
    with open(sp_route, 'w', encoding='utf-8') as f:
        f.write(sp)

eb_route = 'server/modules/procurement/procurement.routes.ts'
with open(eb_route, 'r', encoding='utf-8') as f:
    eb = f.read()
eb = eb.replace('totalAmount:', '/* totalAmount */')
with open(eb_route, 'w', encoding='utf-8') as f:
    f.write(eb)
