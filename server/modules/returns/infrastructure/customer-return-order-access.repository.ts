import type { Pool } from "pg";
import { z } from "zod";
import { customerReturnOwnedOrderInputSchema, customerReturnOrderListInputSchema } from "../application/customer-return-order-access.service";
import type {
  CustomerReturnOrderAccessRepository,
  CustomerReturnOrderCandidate,
} from "../application/customer-return-order-access.service";

const positiveId = z.union([
  z.number().int().positive().safe(),
  z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().safe()),
]);
const candidateRow = z.object({
  oms_order_id: positiveId,
  channel_id: positiveId,
  external_customer_id: z.string().min(1).max(100).nullable(),
  external_order_id: z.string().min(1).max(100),
  external_order_number: z.string().min(1).max(50),
}).strict();

const queryInput = z.object({
  channelId: z.number().int().positive().safe(),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("customer"), externalCustomerId: z.string().min(1).max(100) }).strict(),
    z.object({ kind: z.literal("order"), omsOrderId: z.number().int().positive().safe(), externalOrderId: z.string().min(1).max(100) }).strict(),
  ]),
  orderNumberAliases: z.array(z.string().min(1).max(100)).min(1).max(3),
}).strict();
const ownedInput = customerReturnOwnedOrderInputSchema.extend({ channelId: queryInput.shape.channelId, scope: queryInput.shape.scope });
const listInput = customerReturnOrderListInputSchema.extend({ channelId: queryInput.shape.channelId,
  externalCustomerId: z.string().min(1).max(100) });
const candidateColumns = `oo.id AS oms_order_id, oo.channel_id, oo.external_customer_id,
  oo.external_order_id, oo.external_order_number`;

function candidates(rows: unknown, maximum: number): CustomerReturnOrderCandidate[] {
  return z.array(candidateRow).max(maximum).parse(rows).map(row => ({
    omsOrderId: row.oms_order_id, channelId: row.channel_id, externalCustomerId: row.external_customer_id,
    externalOrderId: row.external_order_id, externalOrderNumber: row.external_order_number,
  }));
}

export class CustomerReturnOrderReadError extends Error {
  readonly code = "CUSTOMER_RETURN_ORDER_READ_FAILED";
  constructor() {
    super("The return order could not be read.");
    this.name = "CustomerReturnOrderReadError";
  }
}

/** Read port only: the caller supplies a request-scoped, verified principal. */
export class PostgresCustomerReturnOrderAccessRepository implements CustomerReturnOrderAccessRepository {
  constructor(private readonly database: Pick<Pool, "query">) {}

  async findOwnedOrder(raw: Parameters<CustomerReturnOrderAccessRepository["findOwnedOrder"]>[0]): Promise<readonly CustomerReturnOrderCandidate[]> {
    try {
      const input = ownedInput.parse(raw);
      const values: unknown[] = [input.channelId, input.omsOrderId];
      const predicates = ["oo.channel_id = $1", "oo.id = $2"];
      if (input.scope.kind === "customer") {
        values.push(input.scope.externalCustomerId);
        predicates.push("oo.external_customer_id = $3");
      } else {
        values.push(input.scope.omsOrderId, input.scope.externalOrderId);
        predicates.push("oo.id = $3", "oo.external_order_id = $4");
      }
      if (input.externalOrderId !== undefined) {
        values.push(input.externalOrderId);
        predicates.push(`oo.external_order_id = $${values.length}`);
      }
      const result = await this.database.query(`SELECT ${candidateColumns} FROM oms.oms_orders oo
        WHERE ${predicates.join(" AND ")} LIMIT 2`, values);
      return candidates(result.rows, 2);
    } catch { throw new CustomerReturnOrderReadError(); }
  }

  async listOwnedOrders(raw: Parameters<CustomerReturnOrderAccessRepository["listOwnedOrders"]>[0]): Promise<readonly CustomerReturnOrderCandidate[]> {
    try {
      const input = listInput.parse(raw);
      const result = await this.database.query(`SELECT ${candidateColumns} FROM oms.oms_orders oo
        WHERE oo.channel_id = $1 AND oo.external_customer_id = $2
          AND ($3::bigint IS NULL OR oo.id < $3::bigint)
        ORDER BY oo.id DESC LIMIT $4`, [input.channelId, input.externalCustomerId, input.beforeOmsOrderId ?? null, input.pageSize + 1]);
      return candidates(result.rows, input.pageSize + 1);
    } catch { throw new CustomerReturnOrderReadError(); }
  }

  async findExactOrderCandidates(
    raw: Parameters<CustomerReturnOrderAccessRepository["findExactOrderCandidates"]>[0],
  ): Promise<readonly CustomerReturnOrderCandidate[]> {
    const input = queryInput.parse(raw);
    const values: unknown[] = [input.channelId, input.orderNumberAliases];
    let ownershipPredicate: string;
    if (input.scope.kind === "customer") {
      ownershipPredicate = "oo.external_customer_id = $3";
      values.push(input.scope.externalCustomerId);
    } else {
      ownershipPredicate = "oo.id = $3 AND oo.external_order_id = $4";
      values.push(input.scope.omsOrderId, input.scope.externalOrderId);
    }
    try {
      // SQL fragments are fixed above; all identity/reference values are parameters.
      // Two canonical rows are sufficient to detect ambiguity. Never choose the first.
      const result = await this.database.query(`
        SELECT oo.id AS oms_order_id, oo.channel_id, oo.external_customer_id,
               oo.external_order_id, oo.external_order_number
        FROM oms.oms_orders oo
        WHERE oo.channel_id = $1
          AND oo.external_order_number = ANY($2::text[])
          AND ${ownershipPredicate}
        ORDER BY oo.id
        LIMIT 2
      `, values);
      return candidates(result.rows, 2);
    } catch {
      // Keep raw driver/query/customer data out of caller-visible errors.
      throw new CustomerReturnOrderReadError();
    }
  }
}
