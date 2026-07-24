import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositorySource = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/oms/channel-fulfillment-authority.repository.ts",
  ),
  "utf8",
);
const migrationSource = readFileSync(
  resolve(process.cwd(), "migrations/171_historical_fulfillment_repair_audit.sql"),
  "utf8",
);

describe("channel fulfillment historical repair audit contract", () => {
  it("records the reviewed command before atomically moving it back to pending", () => {
    const functionStart = repositorySource.indexOf(
      "async function requeueCompatibleCommandConflict(",
    );
    const nextFunction = repositorySource.indexOf(
      "async function persistChannelCommandSet(",
      functionStart,
    );
    const functionSource = repositorySource.slice(functionStart, nextFunction);

    expect(functionStart).toBeGreaterThan(-1);
    expect(functionSource).toContain("WITH audit AS (");
    expect(functionSource).toContain(
      "INSERT INTO oms.channel_fulfillment_push_requeues",
    );
    expect(functionSource).toContain(
      "UPDATE oms.channel_fulfillment_pushes AS command",
    );
    expect(functionSource).toContain("FROM audit");
    expect(functionSource).toContain("command.push_status = 'review'");
    expect(functionSource).toContain(
      "command.last_error_code = 'COMMAND_REQUEST_CONFLICT'",
    );
  });

  it("makes both historical repair audit ledgers append-only", () => {
    expect(migrationSource).toContain(
      "channel_fulfillment_push_requeues_immutable",
    );
    expect(migrationSource).toContain(
      "carrier_dispatch_command_requeues_immutable",
    );
    expect(
      migrationSource.match(
        /EXECUTE FUNCTION wms\.reject_shipping_evidence_ledger_mutation\(\)/g,
      ),
    ).toHaveLength(2);
  });
});
