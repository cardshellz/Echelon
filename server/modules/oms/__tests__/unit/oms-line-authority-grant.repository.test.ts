import { describe, expect, it } from "vitest";

import { DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC } from "../../oms-line-authority";
import {
  dropshipAcceptanceAuthorityEventId,
  grantDropshipAcceptanceLineAuthorityWithClient,
  OmsLineAuthorityGrantError,
  type OmsLineAuthorityGrantClient,
} from "../../oms-line-authority-grant.repository";

const ACCEPTED_AT = new Date("2026-10-03T15:42:09.000Z");
const SOURCE_EVENT_ID = "dropship-acceptance:intake:43";

interface FakeLine {
  id: string | number;
  quantity: number;
  fulfillable_quantity: number | null;
  channel_observed_quantity: number;
  paid_quantity: number;
  authority_fulfillable_quantity: number;
  cancelled_quantity: number;
  refunded_quantity: number;
  authorization_status: string;
  authorized_at: Date | null;
  authorized_by_event_id: string | null;
  authority_source_topic: string | null;
}

// OMS order 1013417's line as acceptance created it: the authority columns sit
// at their migration 106 defaults, and node-postgres returns the BIGINT id as text.
function stagedLine(overrides: Partial<FakeLine> = {}): FakeLine {
  return {
    id: "5550001",
    quantity: 1,
    fulfillable_quantity: 1,
    channel_observed_quantity: 0,
    paid_quantity: 0,
    authority_fulfillable_quantity: 0,
    cancelled_quantity: 0,
    refunded_quantity: 0,
    authorization_status: "authorized",
    authorized_at: null,
    authorized_by_event_id: null,
    authority_source_topic: null,
    ...overrides,
  };
}

class FakeGrantClient {
  readonly queries: Array<{ text: string; values: unknown[] }> = [];

  constructor(
    private readonly order: { id: string; financial_status: string | null } | null,
    private readonly lines: FakeLine[],
    private readonly updateRowCount = 1,
  ) {}

  async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push({ text, values });
    if (text.includes("FROM oms.oms_orders")) {
      return { rows: this.order ? [this.order] : [], rowCount: this.order ? 1 : 0 };
    }
    if (text.includes("FROM oms.oms_order_lines")) {
      return { rows: this.lines, rowCount: this.lines.length };
    }
    if (text.startsWith("UPDATE oms.oms_order_lines")) {
      return { rows: [], rowCount: this.updateRowCount };
    }
    if (text.startsWith("INSERT INTO oms.oms_order_line_authority_events")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${text}`);
  }

  asClient(): OmsLineAuthorityGrantClient {
    return this as unknown as OmsLineAuthorityGrantClient;
  }

  writes(): Array<{ text: string; values: unknown[] }> {
    return this.queries.filter((query) => /^(UPDATE|INSERT)/.test(query.text));
  }
}

const paidOrder = { id: "1013417", financial_status: "paid" };

function grantInput(overrides: Partial<{ omsOrderId: number; sourceEventId: string; authorizedAt: Date }> = {}) {
  return {
    omsOrderId: 1013417,
    sourceEventId: SOURCE_EVENT_ID,
    authorizedAt: ACCEPTED_AT,
    ...overrides,
  };
}

async function grantError(client: FakeGrantClient, input = grantInput()): Promise<OmsLineAuthorityGrantError> {
  const error = await grantDropshipAcceptanceLineAuthorityWithClient(client.asClient(), input)
    .then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(OmsLineAuthorityGrantError);
  return error as OmsLineAuthorityGrantError;
}

describe("grantDropshipAcceptanceLineAuthorityWithClient", () => {
  it("grants paid authority to the staged line and appends its ledger event (order 22039)", async () => {
    const client = new FakeGrantClient(paidOrder, [stagedLine()]);

    const granted = await grantDropshipAcceptanceLineAuthorityWithClient(client.asClient(), grantInput());

    expect(granted).toEqual([{
      omsOrderLineId: 5550001,
      previousAuthorityFulfillableQuantity: 0,
      authorityFulfillableQuantity: 1,
      changed: true,
    }]);
    // Order row first, then its lines: both locked before any write.
    expect(client.queries[0].text).toMatch(/FROM oms\.oms_orders[\s\S]*FOR UPDATE/);
    expect(client.queries[0].values).toEqual([1013417]);
    expect(client.queries[1].text).toMatch(/FROM oms\.oms_order_lines[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/);

    const [update, insert] = client.writes();
    expect(update.text).toMatch(/^UPDATE oms\.oms_order_lines[\s\S]*WHERE id = \$1$/);
    expect(update.values).toEqual([
      5550001,
      1,
      1,
      1,
      "authorized",
      ACCEPTED_AT,
      SOURCE_EVENT_ID,
      DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC,
      null,
    ]);

    expect(insert.text).toContain("ON CONFLICT (event_key) DO NOTHING");
    const [eventKey, eventType, orderId, orderLineId, sourceTopic, sourceEventId, sourceInboxId,
      previousObserved, previousPaid, previousFulfillable, previousStatus,
      observed, paid, fulfillable, cancelled, refunded, status, authorizedAt, authorizedBy, createdAt] = insert.values;
    expect(eventKey).toBe([
      "oms-line-authority",
      "type:line_updated",
      "line:5550001",
      `topic:${DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC}`,
      `source:${SOURCE_EVENT_ID}`,
      "observed:1",
      "paid:1",
      "fulfillable:1",
      "cancelled:0",
      "refunded:0",
      "status:authorized",
    ].join("|"));
    expect({ eventType, orderId, orderLineId, sourceTopic, sourceEventId, sourceInboxId }).toEqual({
      eventType: "line_updated",
      orderId: 1013417,
      orderLineId: 5550001,
      sourceTopic: DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC,
      sourceEventId: SOURCE_EVENT_ID,
      sourceInboxId: null,
    });
    expect([previousObserved, previousPaid, previousFulfillable, previousStatus]).toEqual([0, 0, 0, "authorized"]);
    expect([observed, paid, fulfillable, cancelled, refunded, status]).toEqual([1, 1, 1, 0, 0, "authorized"]);
    // Both timestamps come from the acceptance clock, not the database's.
    expect([authorizedAt, authorizedBy, createdAt]).toEqual([ACCEPTED_AT, SOURCE_EVENT_ID, ACCEPTED_AT]);
  });

  it("grants every line of a multi-line order, capped at its fulfillable quantity", async () => {
    const client = new FakeGrantClient(paidOrder, [
      stagedLine({ id: "11", quantity: 2, fulfillable_quantity: 2 }),
      stagedLine({ id: "12", quantity: 3, fulfillable_quantity: 1 }),
    ]);

    const granted = await grantDropshipAcceptanceLineAuthorityWithClient(client.asClient(), grantInput());

    expect(granted.map((line) => [line.omsOrderLineId, line.authorityFulfillableQuantity])).toEqual([
      [11, 2],
      [12, 1],
    ]);
    expect(client.writes().map((write) => write.text.split(/\s/)[0])).toEqual(["UPDATE", "INSERT", "UPDATE", "INSERT"]);
  });

  it("writes nothing when the line already carries this grant (a replay)", async () => {
    const client = new FakeGrantClient(paidOrder, [stagedLine({
      channel_observed_quantity: 1,
      paid_quantity: 1,
      authority_fulfillable_quantity: 1,
      authorization_status: "authorized",
      authorized_at: ACCEPTED_AT,
      authorized_by_event_id: SOURCE_EVENT_ID,
      authority_source_topic: DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC,
    })]);

    const granted = await grantDropshipAcceptanceLineAuthorityWithClient(
      client.asClient(),
      grantInput({ authorizedAt: new Date("2026-10-03T16:00:00.000Z") }),
    );

    expect(granted).toEqual([{
      omsOrderLineId: 5550001,
      previousAuthorityFulfillableQuantity: 1,
      authorityFulfillableQuantity: 1,
      changed: false,
    }]);
    expect(client.writes()).toEqual([]);
  });

  it.each([
    { label: "pending", financialStatus: "pending" },
    { label: "refunded", financialStatus: "refunded" },
    { label: "missing", financialStatus: null },
  ])("refuses a $label order: authority needs payment", async ({ financialStatus }) => {
    const client = new FakeGrantClient({ id: "1013417", financial_status: financialStatus }, [stagedLine()]);

    const error = await grantError(client);

    expect(error.code).toBe("OMS_LINE_AUTHORITY_GRANT_ORDER_NOT_PAID");
    expect(error.context).toEqual({ omsOrderId: 1013417, financialStatus });
    expect(client.writes()).toEqual([]);
  });

  it("accepts the paid status in any letter case", async () => {
    const client = new FakeGrantClient({ id: "1013417", financial_status: "PAID" }, [stagedLine()]);

    const granted = await grantDropshipAcceptanceLineAuthorityWithClient(client.asClient(), grantInput());

    expect(granted[0].authorityFulfillableQuantity).toBe(1);
  });

  it("refuses an order that does not exist", async () => {
    const client = new FakeGrantClient(null, []);

    const error = await grantError(client);

    expect(error.code).toBe("OMS_LINE_AUTHORITY_GRANT_ORDER_NOT_FOUND");
    expect(client.writes()).toEqual([]);
  });

  it("refuses a paid order without lines", async () => {
    const client = new FakeGrantClient(paidOrder, []);

    const error = await grantError(client);

    expect(error.code).toBe("OMS_LINE_AUTHORITY_GRANT_NO_LINES");
    expect(client.writes()).toEqual([]);
  });

  it.each([
    { label: "cancelled", overrides: { cancelled_quantity: 1 } },
    { label: "refunded", overrides: { refunded_quantity: 1 } },
  ])("refuses a $label line instead of authorizing its whole quantity", async ({ overrides }) => {
    const client = new FakeGrantClient(paidOrder, [stagedLine(overrides)]);

    const error = await grantError(client);

    expect(error.code).toBe("OMS_LINE_AUTHORITY_GRANT_LINE_ADJUSTED");
    expect(error.context).toMatchObject({ omsOrderId: 1013417, omsOrderLineId: 5550001 });
    expect(client.writes()).toEqual([]);
  });

  it("refuses when the locked line is not updated", async () => {
    const client = new FakeGrantClient(paidOrder, [stagedLine()], 0);

    const error = await grantError(client);

    expect(error.code).toBe("OMS_LINE_AUTHORITY_GRANT_WRITE_MISSED");
    expect(client.writes().map((write) => write.text.split(/\s/)[0])).toEqual(["UPDATE"]);
  });

  it.each([
    { label: "a zero order id", input: { omsOrderId: 0 } },
    { label: "a fractional order id", input: { omsOrderId: 1.5 } },
    { label: "a blank source id", input: { sourceEventId: "   " } },
    { label: "a source id longer than its column", input: { sourceEventId: "x".repeat(101) } },
    { label: "an invalid date", input: { authorizedAt: new Date("not a date") } },
  ])("rejects $label before touching the database", async ({ input }) => {
    const client = new FakeGrantClient(paidOrder, [stagedLine()]);

    const error = await grantError(client, grantInput(input));

    expect(error.code).toBe("OMS_LINE_AUTHORITY_GRANT_INVALID_INPUT");
    expect(client.queries).toEqual([]);
  });

  it("rejects a line id that is not a positive safe integer", async () => {
    const client = new FakeGrantClient(paidOrder, [stagedLine({ id: "9007199254740993" })]);

    const error = await grantError(client);

    expect(error.code).toBe("OMS_LINE_AUTHORITY_GRANT_INVALID_INPUT");
    expect(client.writes()).toEqual([]);
  });
});

describe("dropshipAcceptanceAuthorityEventId", () => {
  it("names one intake's acceptance", () => {
    expect(dropshipAcceptanceAuthorityEventId(43)).toBe(SOURCE_EVENT_ID);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects intake id %s", (intakeId) => {
    expect(() => dropshipAcceptanceAuthorityEventId(intakeId)).toThrow(OmsLineAuthorityGrantError);
  });
});
