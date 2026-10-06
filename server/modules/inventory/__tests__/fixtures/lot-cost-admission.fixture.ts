import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** For already-owned, reduced physical-owner databases only. Install the real
 * immutable follow-up/return migrations. The empty application table is a FK
 * prerequisite, not proof of financial source application; that proof uses
 * migration222's complete schema in lot-cost-ownership.integration.test.ts.
 */
export async function installLotCostAdmissionFixture(client: { query(text: string): Promise<unknown> }, options: {
  returns?: boolean;
  cogs?: boolean;
  qualify?: (statement: string) => string;
} = {}): Promise<void> {
  const qualify = options.qualify ?? ((statement: string)=>statement);
  await client.query(qualify(`ALTER TABLE inventory.inventory_lots ADD COLUMN IF NOT EXISTS cost_precision_version integer DEFAULT 0;
    ALTER TABLE inventory.inventory_lots ALTER COLUMN cost_precision_version SET DEFAULT 0;
    ALTER TABLE inventory.inventory_lots ADD COLUMN IF NOT EXISTS cost_provisional integer DEFAULT 0;
    ALTER TABLE inventory.inventory_lots ADD COLUMN IF NOT EXISTS cost_source varchar(30);
    ALTER TABLE inventory.inventory_lots ADD COLUMN IF NOT EXISTS qty_received integer;
    CREATE TABLE IF NOT EXISTS inventory.cost_applications(id bigint PRIMARY KEY);
    ALTER TABLE inventory.cost_applications ADD COLUMN IF NOT EXISTS id bigint PRIMARY KEY;`));
  if (options.cogs !== false) await client.query(qualify(`
    ALTER TABLE oms.order_item_costs ADD COLUMN IF NOT EXISTS cost_precision_version integer DEFAULT 0;
    ALTER TABLE oms.order_item_costs ALTER COLUMN cost_precision_version SET DEFAULT 0;`));
  const source = readFileSync(resolve(process.cwd(),"migrations/222_procurement_cost_evidence.sql"),"utf8");
  const immutableFunction = source.match(/CREATE OR REPLACE FUNCTION inventory\.reject_cost_evidence_mutation\(\)[\s\S]*?\$\$;/)?.[0];
  if (!immutableFunction) throw new Error("Cost evidence fixture immutable-function boundary changed");
  await client.query(qualify(immutableFunction));
  for (const name of ["0724_inventory_cost_admission_evidence.sql",...(options.returns ? ["0725_inventory_return_cost_allocations.sql"] : [])]) {
    const table = name.includes("cost_admission_evidence") ? "lot_cost_follow_ups" : "return_cost_allocations";
    const result = await client.query(qualify(`SELECT to_regclass('inventory.${table}') AS relation`)) as { rows: { relation: string | null }[] };
    if (result.rows[0]?.relation === null) {
      await client.query(qualify(readFileSync(resolve(process.cwd(),"migrations",name),"utf8")));
    }
  }
}
