import type { Pool } from "pg";
import { OrderEditError } from "../domain/order-edit-error";
import { OrderEditWarehouseGateway } from "./order-edit-warehouse.gateway";

export type OrderEditReadSmokeResult =
  | { outcome: "skipped"; reason: "no_orders" }
  | { outcome: "passed"; omsOrderId: number }
  | { outcome: "refused"; omsOrderId: number; code: string };

function unusedWriter(name: string) {
  return () => {
    throw new Error(`Order edit release smoke must not call ${name}.`);
  };
}

/**
 * Runs the order editor's read-only warehouse inspection against the newest
 * order in the target database, using the exact SQL the customer editor runs.
 *
 * PostgreSQL validates column names and enum literals when it plans the
 * statement, so a query that no longer matches the deployed schema fails here
 * even when the chosen order has no warehouse rows. A business refusal
 * (OrderEditError) proves the SQL executed and is not a release failure; any
 * other error is rethrown so the release stops before customers see it.
 *
 * Inspection uses a REPEATABLE READ READ ONLY transaction and never calls the
 * shipping provider or the synchronizer, which are wired to throw.
 */
export async function runOrderEditReadSmoke(
  pool: Pick<Pool, "connect">,
): Promise<OrderEditReadSmokeResult> {
  const client = await pool.connect();
  let omsOrderId: number | null;
  try {
    const newest = await client.query(
      "SELECT id FROM oms.oms_orders ORDER BY id DESC LIMIT 1",
    );
    omsOrderId = newest.rows.length ? Number(newest.rows[0].id) : null;
  } finally {
    client.release();
  }
  if (omsOrderId === null) return { outcome: "skipped", reason: "no_orders" };
  const gateway = new OrderEditWarehouseGateway(
    pool,
    {
      isConfigured: unusedWriter("the shipping provider"),
      synchronizeOrderEditShipment: unusedWriter("the shipping provider"),
    },
    unusedWriter("the OMS synchronizer"),
  );
  try {
    await gateway.inspect(omsOrderId);
  } catch (error) {
    if (error instanceof OrderEditError)
      return { outcome: "refused", omsOrderId, code: error.code };
    throw error;
  }
  return { outcome: "passed", omsOrderId };
}
