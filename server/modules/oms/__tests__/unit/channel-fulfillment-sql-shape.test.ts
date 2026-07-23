import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ingressSource = fs.readFileSync(
  path.resolve(process.cwd(), "server/modules/oms/channel-fulfillment-ingress.repository.ts"),
  "utf8",
);
const pushSource = fs.readFileSync(
  path.resolve(process.cwd(), "server/modules/oms/fulfillment-push.service.ts"),
  "utf8",
);

describe("canonical fulfillment SQL array bindings", () => {
  it("does not cast interpolated JavaScript arrays as PostgreSQL arrays", () => {
    expect(ingressSource).not.toContain("}::text[])");
    expect(ingressSource).not.toContain("}::int[])");
    expect(pushSource).not.toContain("}::text[])");
    expect(pushSource).not.toContain("}::bigint[])");
  });

  it("uses typed PostgreSQL ARRAY builders on outbound and inbound paths", () => {
    expect(ingressSource).toContain("sqlTextArray(lineIds)");
    expect(ingressSource).toContain("sqlTextArray(providerIds)");
    expect(ingressSource).toContain("sqlIntegerArray(wmsOrderIds)");
    expect(pushSource).toContain("sqlBigintArray(legacyWmsShipmentIds)");
    expect(pushSource).toContain("sqlTextArray(deadFulfillmentIds)");
  });
});
