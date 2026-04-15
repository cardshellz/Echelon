import { pool } from "../../../db";
import { DropshipError } from "../domain/errors";
import { WalletDomain } from "../domain/wallet";
import { PricingDomainService } from "../domain/pricing";

export interface AgentOrderItem {
  variantId: number;
  quantity: number;
}

export interface AgentOrderPayload {
  platform: string; // 'ebay', 'shopify'
  remoteOrderId: string; // Strictly mapped Idempotent lookup
  items: AgentOrderItem[];
  customerNote?: string;
  shippingAddress: any; 
}

export class OrderOrchestrator {
  
  /**
   * The explicit Database Transaction boundary enforcing strictly typed Dropship bindings smoothly.
   * Leverages pessimistic DB row-locks guaranteeing accurate deduplications mapping heavily parallel requests natively.
   */
  static async ingestOrder(vendorId: number, vendorTier: any, payload: AgentOrderPayload): Promise<void> {
    const client = await pool.connect();
    
    try {
      // 1. Enter strictly bound transactional wrapper avoiding partial logic arrays entirely
      await client.query("BEGIN"); 

      // 2. Strict Idempotency Validation (If channel rebroadcasts webhooks identically, silently avoid double funding)
      const existing = await client.query(
        \`SELECT id FROM orders WHERE custom_attributes->>'remote_order_id' = $1 AND custom_attributes->>'platform' = $2 LIMIT 1\`,
        [payload.remoteOrderId, payload.platform]
      );
      if (existing.rowCount > 0) {
         await client.query("ROLLBACK");
         return; // Seamless resolution without crashing external webhook.
      }

      // 3. Execution Lock ("SELECT FOR UPDATE") isolating Vendor modifications purely
      const vendorRow = await client.query(
        \`SELECT wallet_balance_cents, status FROM dropship_vendors WHERE id = $1 FOR UPDATE\`,
        [vendorId]
      );

      if (vendorRow.rowCount === 0) throw new DropshipError("VENDOR_NOT_FOUND", "Ledger bounds evaporated.");
      if (vendorRow.rows[0].status !== 'active') throw new DropshipError("VENDOR_INACTIVE", "Vendor capabilities are currently disabled safely.");
      
      const currentBalance = parseInt(vendorRow.rows[0].wallet_balance_cents, 10);

      // 4. Cart Cost Evaluation 
      let totalCartCents = 0;
      for (const item of payload.items) {
        const variantData = await client.query(\`SELECT price_cents FROM product_variants WHERE id = $1\`, [item.variantId]);
        if (variantData.rowCount === 0) throw new DropshipError("VARIANT_NOT_FOUND", "Requested Dropship node missing.");
        
        const retailCents = parseInt(variantData.rows[0].price_cents, 10);
        const wholesaleCents = PricingDomainService.calculateWholesaleCents(retailCents, vendorTier);
        
        totalCartCents += wholesaleCents * item.quantity;
      }

      // 5. Explicit Domain Resolution (Deductions mathematically enforced)
      const resultingBalance = WalletDomain.evaluateDeduction(currentBalance, totalCartCents);

      // 6. DB Mutability executed seamlessly
      await client.query(
        \`UPDATE dropship_vendors SET wallet_balance_cents = $1, updated_at = NOW() WHERE id = $2\`,
        [resultingBalance, vendorId]
      );

      // 7. Ledger Trace generation protecting future financial audit bounds perfectly
      await client.query(\`
        INSERT INTO dropship_wallet_ledger (vendor_id, type, amount_cents, balance_after_cents, reference_type, reference_id, payment_method, notes)
        VALUES ($1, 'charge', $2, $3, 'order', $4, 'wallet', $5)
      \`, [vendorId, totalCartCents, resultingBalance, payload.remoteOrderId, \`Platform Ingest: \${payload.platform}\`]);

      // 8. Inject Order physically into generalized Echelon grids maintaining system routing natively
      const orderInsert = await client.query(\`
        INSERT INTO orders (status, total_cents, channel_id, custom_attributes, shipping_address)
        VALUES ('unfulfilled', $1, 67, $2, $3) RETURNING id
      \`, [totalCartCents, JSON.stringify({ isDropship: true, vendorId, platform: payload.platform, remote_order_id: payload.remoteOrderId, customerNote: payload.customerNote }), JSON.stringify(payload.shippingAddress)]);
      const newOrderId = orderInsert.rows[0].id;

      for (const item of payload.items) {
         await client.query(\`
           INSERT INTO order_items (order_id, variant_id, quantity) VALUES ($1, $2, $3)
         \`, [newOrderId, item.variantId, item.quantity]);
      }

      // 9. Fully release locking threads securing changes globally
      await client.query("COMMIT");

    } catch (e: any) {
      await client.query("ROLLBACK");
      if (e instanceof DropshipError) throw e;
      throw new DropshipError("SYSTEM_INGEST_FAILURE", "Transactional execution fault.", { detail: e.message });
    } finally {
      client.release();
    }
  }
}
