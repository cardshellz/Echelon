import { Router, Request, Response } from 'express';
import { db } from '../../db';
import {
  orders as legacyOrders,
  orderItems as legacyOrderItems,
  wmsOrders,
  wmsOrderItems
} from '@shared/schema/orders.schema';
import {
  omsOrders,
  omsOrderLines,
  omsOrderEvents
} from '@shared/schema/oms.schema';

export const shadowIngestionRouter = Router();

export function registerShadowIngestionRoutes(app: import('express').Express) {
  app.use('/api/oms', shadowIngestionRouter);
}

/**
 * POST /api/oms/shadow-ingest
 * This is the Shadow Mode ingestion engine. It accepts normalized order data (e.g., from Shopify/eBay bridges)
 * and writes it to BOTH the legacy flat WMS architecture AND the new segregated OMS/WMS namespaces.
 */
shadowIngestionRouter.post('/shadow-ingest', async (req: Request, res: Response) => {
  const payload = req.body;

  // Basic validation
  if (!payload || !payload.id) {
    return res.status(400).json({ error: 'Invalid order payload' });
  }

  try {
    // ===========================================
    // 1. Write to Legacy System (Guarantees safety for current warehouse ops)
    // ===========================================
    const [legacyOrder] = await db.insert(legacyOrders).values({
      channelId: payload.channelId,
      source: payload.source || 'shopify',
      externalOrderId: payload.id.toString(),
      orderNumber: payload.name,
      customerName: payload.customer?.name || 'Guest',
      shippingName: payload.shippingAddress?.name,
      shippingAddress: payload.shippingAddress?.address1,
      // Includes legacy financials
      totalAmount: payload.totalPrice
    }).returning();

    if (payload.lineItems && payload.lineItems.length > 0) {
      const legacyLines = payload.lineItems.map((item: any) => ({
        orderId: legacyOrder.id,
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        priceCents: Math.round(parseFloat(item.price || 0) * 100)
      }));
      await db.insert(legacyOrderItems).values(legacyLines);
    }

    // ===========================================
    // 2. Write to New OMS Namespace (Financials & Normalization)
    // ===========================================
    const [omsOrder] = await db.insert(omsOrders).values({
      channelId: payload.channelId,
      externalOrderId: payload.id.toString(),
      externalOrderNumber: payload.name,
      customerEmail: payload.customer?.email,
      status: 'validating',
      financialStatus: 'paid',
      totalCents: Math.round(parseFloat(payload.totalPrice || 0) * 100),
      currency: 'USD',
      orderedAt: new Date()
    }).returning();

    if (payload.lineItems && payload.lineItems.length > 0) {
      const omsLines = payload.lineItems.map((item: any) => ({
        orderId: omsOrder.id,
        sku: item.sku,
        quantity: item.quantity,
        paidPriceCents: Math.round(parseFloat(item.price || 0) * 100),
      }));
      await db.insert(omsOrderLines).values(omsLines);
    }

    // ===========================================
    // 3. Write to New WMS Namespace (Blind Execution)
    // ===========================================
    const [wmsOrder] = await db.insert(wmsOrders).values({
      omsFulfillmentOrderId: omsOrder.id.toString(),
      channelId: payload.channelId,
      source: payload.source || 'shopify',
      externalOrderId: payload.id.toString(),
      orderNumber: payload.name,
      customerName: payload.customer?.name || 'Guest',
      shippingName: payload.shippingAddress?.name,
      warehouseStatus: 'ready',
      priority: 100
      // No financials included here!
    }).returning();

    if (payload.lineItems && payload.lineItems.length > 0) {
      const wmsLines = payload.lineItems.map((item: any) => ({
        wmsOrderId: wmsOrder.id,
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        status: 'pending'
        // No financials, just pure picking logic
      }));
      await db.insert(wmsOrderItems).values(wmsLines);
    }

    res.status(200).json({
      message: 'Shadow ingestion successful',
      legacyOrderId: legacyOrder.id,
      omsOrderId: omsOrder.id,
      wmsOrderId: wmsOrder.id
    });

  } catch (err: any) {
    console.error('Shadow ingestion error:', err);
    res.status(500).json({ error: err.message });
  }
});
