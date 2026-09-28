import type { Pool } from "pg";
import { z } from "zod";
import {
  customerReturnCustomerPrincipalSchema,
  customerReturnOwnedAuthorizationSchema,
  customerReturnOwnedCommandSchema,
  type CustomerReturnCustomerOwnershipReader,
  type CustomerReturnCustomerPrincipal,
} from "../application/customer-return-customer-operations.service";
import { CustomerReturnIntakeError } from "../application/customer-return-intake.ports";
import { customerReturnCustomerHistoryInputSchema, customerReturnCustomerHistoryItemSchema } from "@shared/returns/customer-return-customer.contract";

const id = z.number().int().positive().safe();
const databaseId = z.union([id, z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(id)]);
const orderRow = z.object({ oms_order_id: databaseId, authorization_id: databaseId.nullable() }).strict();

/** Neither current eligibility nor the current policy affects access to accepted return history. */
export class PostgresCustomerReturnCustomerOwnershipReader implements CustomerReturnCustomerOwnershipReader {
  constructor(private readonly database: Pick<Pool, "query">) {}

  async listReturns(rawPrincipal: CustomerReturnCustomerPrincipal, rawInput: z.infer<typeof customerReturnCustomerHistoryInputSchema>) {
    const principal = customerReturnCustomerPrincipalSchema.parse(rawPrincipal);
    const input = customerReturnCustomerHistoryInputSchema.parse(rawInput);
    return this.read(async () => {
      const result = await this.database.query(`SELECT a.id, a.authorization_number, a.oms_order_id,
          o.external_order_number, a.created_at
        FROM returns.customer_return_authorizations a
        JOIN oms.oms_orders o ON o.id = a.oms_order_id AND o.channel_id = a.channel_id
        WHERE a.channel_id = $1 AND o.external_customer_id = $2
          AND ($3::bigint IS NULL OR a.id < $3)
        ORDER BY a.id DESC LIMIT $4`,
      [principal.channelId, principal.externalCustomerId, input.beforeAuthorizationId ?? null, input.pageSize + 1]);
      const rows = z.array(z.object({ id: databaseId, authorization_number: z.string(), oms_order_id: databaseId,
        external_order_number: z.string().nullable(), created_at: z.coerce.date(),
      }).strict()).max(input.pageSize + 1).parse(result.rows);
      return rows.map(row => customerReturnCustomerHistoryItemSchema.parse({
        authorizationId: row.id, authorizationNumber: row.authorization_number, omsOrderId: row.oms_order_id,
        orderReference: row.external_order_number, createdAt: row.created_at.toISOString(),
      }));
    });
  }

  async readOwnedAuthorization(rawPrincipal: CustomerReturnCustomerPrincipal, rawAuthorizationId: number) {
    const principal = customerReturnCustomerPrincipalSchema.parse(rawPrincipal);
    const authorizationId = id.parse(rawAuthorizationId);
    return this.read(async () => {
      const result = await this.database.query(`SELECT a.oms_order_id, a.id AS authorization_id
        FROM returns.customer_return_authorizations a
        JOIN oms.oms_orders o ON o.id = a.oms_order_id AND o.channel_id = a.channel_id
        WHERE a.id = $1 AND a.channel_id = $2 AND o.external_customer_id = $3`,
      [authorizationId, principal.channelId, principal.externalCustomerId]);
      const row = z.array(orderRow).max(1).parse(result.rows)[0];
      return row ? customerReturnOwnedAuthorizationSchema.parse({ authorizationId: row.authorization_id, omsOrderId: row.oms_order_id }) : null;
    });
  }

  async readOwnedCommand(rawPrincipal: CustomerReturnCustomerPrincipal, rawKey: string) {
    const principal = customerReturnCustomerPrincipalSchema.parse(rawPrincipal);
    const key = z.string().uuid().parse(rawKey);
    return this.read(async () => {
      // Unbound legacy/staff commands never become customer grants, even when an
      // order display number happens to match. The immutable OMS FK is authority.
      const result = await this.database.query(`SELECT c.oms_order_id, c.authorization_id
        FROM returns.customer_return_submission_commands c
        JOIN oms.oms_orders o ON o.id = c.oms_order_id AND o.channel_id = c.channel_id
        WHERE c.idempotency_key = $1 AND c.channel_id = $2 AND o.external_customer_id = $3`,
      [key, principal.channelId, principal.externalCustomerId]);
      const row = z.array(orderRow).max(1).parse(result.rows)[0];
      return row ? customerReturnOwnedCommandSchema.parse({ authorizationId: row.authorization_id, omsOrderId: row.oms_order_id }) : null;
    });
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch {
      throw new CustomerReturnIntakeError("CUSTOMER_RETURN_ACCESS_UNAVAILABLE", "Return access could not be verified. Please try again.", 503);
    }
  }
}
