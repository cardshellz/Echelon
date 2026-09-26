import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresCustomerReturnIntakeStore } from "../../infrastructure/customer-return-intake.repository";
import { PostgresCustomerReturnAuthorizationStore } from "../../infrastructure/customer-return-authorization.repository";
import { PostgresCustomerReturnLocalInspectionReader } from "../../infrastructure/customer-return-local-inspection.reader";
import { __test__ as refundCascadeTest } from "../../../oms/shopify-refund-cascade.service";
import { createReturnsService } from "../../../orders/returns.service";
import { resolveReturnsTestDatabase } from "../support/disposable-database";
import {
  createIntakeTestSchema,
  seedIntakeTestSchema,
  preparedIntake,
  seedIntakeSubmission,
  INTAKE_KEY,
  INTAKE_LEASE,
  INTAKE_NOW,
} from "../support/customer-return-intake-database";

const connectionString = resolveReturnsTestDatabase(process.env, "intake");
const integration = connectionString ? describe.sequential : describe.skip;

integration("private return intake on migration-defined PostgreSQL", () => {
  let pool: Pool;
  let store: PostgresCustomerReturnIntakeStore;
  beforeAll(async () => {
    pool = new Pool({
      connectionString: connectionString!,
      max: 8,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    });
    await createIntakeTestSchema(pool);
    store = new PostgresCustomerReturnIntakeStore(drizzle(pool));
  });
  beforeEach(async () => seedIntakeTestSchema(pool));
  afterAll(async () => {
    await pool?.end();
  });
  const counts = async () =>
    (
      await pool.query(`SELECT
    (SELECT COUNT(*) FROM returns.customer_return_authorizations)::int AS roots,
    (SELECT COUNT(*) FROM returns.return_cases)::int AS cases,
    (SELECT COUNT(*) FROM wms.return_items)::int AS items,
    (SELECT COUNT(*) FROM returns.customer_return_parcels)::int AS parcels`)
    ).rows[0];

  function partialIntake() {
    const full = preparedIntake();
    return {
      ...full,
      lines: [
        {
          ...full.lines[0],
          quantity: 1,
          allocations: [{ ...full.lines[0].allocations[0], quantity: 1 }],
        },
      ],
      expectedClaims: full.expectedClaims.filter(
        (claim) => claim.wmsOrderItemId !== 303,
      ),
      parcels: [
        { ...full.parcels[0], items: [{ omsOrderLineId: 101, quantity: 1 }] },
      ],
    };
  }
  async function recordProvenRestock(caseId: number): Promise<number> {
    const item = (
      await pool.query(
        `SELECT id,wms_return_item_id FROM returns.return_case_items WHERE return_case_id=$1`,
        [caseId],
      )
    ).rows[0];
    await pool.query(`UPDATE wms.return_items SET received_qty=1 WHERE id=$1`, [
      item.wms_return_item_id,
    ]);
    const inspection = (
      await pool.query(
        `INSERT INTO returns.return_case_inspections(return_case_id,status,started_at,started_by,completed_at,completed_by)
      VALUES($1,'approved',$2,'test',$2,'test') RETURNING id`,
        [caseId, INTAKE_NOW],
      )
    ).rows[0].id;
    const disposition = (
      await pool.query(
        `INSERT INTO returns.return_case_dispositions(return_case_id,inspection_id,inspection_resolution,
      idempotency_key,request_hash,recorded_by,recorded_at) VALUES($1,$2,'approved','disposition',$3,'test',$4) RETURNING id`,
        [caseId, inspection, "d".repeat(64), INTAKE_NOW],
      )
    ).rows[0].id;
    const dispositionItem = (
      await pool.query(
        `INSERT INTO returns.return_case_disposition_items(disposition_id,return_case_item_id,treatment,quantity)
      VALUES($1,$2,'restock_sellable',1) RETURNING id`,
        [disposition, item.id],
      )
    ).rows[0].id;
    const location = (
      await pool.query(
        `INSERT INTO warehouse.warehouse_locations(code) VALUES('TEST-RESTOCK') RETURNING id`,
      )
    ).rows[0].id;
    const lot = (
      await pool.query(
        `INSERT INTO inventory.inventory_lots(lot_number,product_variant_id,warehouse_location_id,received_at)
      VALUES('TEST-RESTOCK',501,$1,$2) RETURNING id`,
        [location, INTAKE_NOW],
      )
    ).rows[0].id;
    const ledger = (
      await pool.query(
        `INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id,order_item_id,
      reference_type,reference_id,source_state,target_state,product_variant_id,to_location_id,inventory_lot_id)
      VALUES('return',1,201,301,'return_inventory_treatment',$1,'customer_return','on_hand',501,$2,$3) RETURNING id`,
        [String(dispositionItem), location, lot],
      )
    ).rows[0].id;
    const treatment = (
      await pool.query(
        `INSERT INTO returns.return_case_inventory_treatments(return_case_id,idempotency_key,request_hash,applied_by,applied_at)
      VALUES($1,'treatment',$2,'test',$3) RETURNING id`,
        [caseId, "e".repeat(64), INTAKE_NOW],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO returns.return_case_inventory_treatment_items(inventory_treatment_id,disposition_item_id,return_case_item_id,
      treatment,quantity,warehouse_location_id,inventory_transaction_id,inventory_lot_id) VALUES($1,$2,$3,'restock_sellable',1,$4,$5,$6)`,
      [treatment, dispositionItem, item.id, location, ledger, lot],
    );
    return Number(ledger);
  }

  it("atomically persists split children, same-SKU purchased identities, exact box manifests and accepted lease", async () => {
    const result = await store.persist(preparedIntake());
    expect(result.replayed).toBe(false);
    expect(result.cases.map((item) => item.wmsOrderId)).toEqual([201, 202]);
    expect(result.parcels.map((item) => item.parcelKey)).toEqual(["1", "2"]);
    expect(result.parcels[0].providerExternalShipmentId).toBe(
      `ecr-${result.authorizationId}-${result.parcels[0].parcelId}`,
    );
    expect(await counts()).toEqual({
      roots: 1,
      cases: 2,
      items: 3,
      parcels: 2,
    });
    expect(
      (
        await pool.query(
          `SELECT status,authorization_id::int AS id FROM returns.customer_return_submission_commands WHERE idempotency_key=$1`,
          [INTAKE_KEY],
        )
      ).rows[0],
    ).toEqual({ status: "accepted", id: result.authorizationId });
    expect(
      (
        await pool.query(
          `SELECT COUNT(*)::int AS n FROM returns.customer_return_allocation_case_items`,
        )
      ).rows[0].n,
    ).toBe(3);
    expect(
      (
        await pool.query(
          `SELECT wms_order_item_id,claimed_quantity::int AS qty FROM returns.customer_return_claimed_quantities ORDER BY wms_order_item_id`,
        )
      ).rows,
    ).toEqual([
      { wms_order_item_id: 301, qty: 2 },
      { wms_order_item_id: 302, qty: 1 },
      { wms_order_item_id: 303, qty: 1 },
    ]);
  });

  it("counts linked children only once in the authorization lock reader", async () => {
    await store.persist(preparedIntake());
    const locked = await new PostgresCustomerReturnAuthorizationStore(
      drizzle(pool),
    ).transaction((tx) =>
      tx.lockSource({
        channelId: 36,
        omsOrderId: 100,
        omsOrderLineIds: [101, 102],
      }),
    );
    expect(
      locked!.lines.map((line) => [
        line.legacyExpectedQuantity,
        line.claimedQuantity,
      ]),
    ).toEqual([
      [0, 3],
      [0, 1],
    ]);
  });

  it("preserves remaining entitlement after an exactly linked portal receipt and restock", async () => {
    const first = await store.persist(partialIntake());
    await recordProvenRestock(first.cases[0].caseId);
    const snapshot = await new PostgresCustomerReturnLocalInspectionReader(
      pool,
      {
        approvedShopDomains: ["test-shop.myshopify.com"],
        clock: () => INTAKE_NOW,
      },
    ).read({ channelId: 36, connectionId: 4, orderReference: "TEST-1" });
    expect(snapshot?.inventoryReturnEvidence).toEqual([]);
    expect(snapshot?.legacyClaims).toEqual([]);
    expect(snapshot?.rootClaims).toHaveLength(1);
    expect(
      snapshot?.issues.filter(
        (issue) => issue.code === "inventory_return_correlation_unknown",
      ),
    ).toEqual([]);
    const next = partialIntake();
    next.idempotencyKey = "00000000-0000-4000-8000-000000000003";
    next.expectedClaims[0].claimedQuantity = 1;
    await seedIntakeSubmission(pool, next.idempotencyKey);
    await expect(store.persist(next)).resolves.toMatchObject({
      replayed: false,
    });
    expect(
      (
        await pool.query(
          `SELECT claimed_quantity::int AS quantity FROM returns.customer_return_claimed_quantities WHERE wms_order_item_id=301`,
        )
      ).rows[0].quantity,
    ).toBe(2);
  });

  it.each([
    "missing_graph",
    "contradictory_quantity",
    "contradictory_variant",
    "contradictory_location",
    "contradictory_lot",
    "voided",
  ])(
    "keeps %s inventory evidence blocked instead of treating reference text as proof",
    async (kind) => {
      const first = await store.persist(partialIntake());
      if (kind === "missing_graph")
        await pool.query(`INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id,order_item_id,reference_type,reference_id)
      VALUES('return',1,201,301,'return_inventory_treatment','999')`);
      else {
        const id = await recordProvenRestock(first.cases[0].caseId);
        if (kind === "contradictory_quantity")
          await pool.query(
            `UPDATE inventory.inventory_transactions SET variant_qty_delta=2 WHERE id=$1`,
            [id],
          );
        if (kind === "contradictory_variant")
          await pool.query(
            `UPDATE inventory.inventory_transactions SET product_variant_id=502 WHERE id=$1`,
            [id],
          );
        if (kind === "contradictory_location")
          await pool.query(
            `UPDATE inventory.inventory_transactions SET to_location_id=NULL WHERE id=$1`,
            [id],
          );
        if (kind === "contradictory_lot")
          await pool.query(
            `UPDATE inventory.inventory_transactions SET inventory_lot_id=NULL WHERE id=$1`,
            [id],
          );
        if (kind === "voided")
          await pool.query(
            `UPDATE inventory.inventory_transactions SET voided_at=$2 WHERE id=$1`,
            [id, INTAKE_NOW],
          );
      }
      const next = partialIntake();
      next.idempotencyKey = "00000000-0000-4000-8000-000000000003";
      next.expectedClaims[0].claimedQuantity = 1;
      await seedIntakeSubmission(pool, next.idempotencyKey);
      await expect(store.persist(next)).rejects.toMatchObject({
        code: "RETURN_INTAKE_SOURCE_CHANGED",
      });
    },
  );

  it("does not block an untouched purchased line for exactly attributable legacy inventory on its sibling", async () => {
    await pool.query(
      `INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id,order_item_id) VALUES('return',1,201,301)`,
    );
    const full = preparedIntake();
    const request = {
      ...full,
      lines: [full.lines[1]],
      expectedClaims: [full.expectedClaims[2]],
      parcels: [
        { ...full.parcels[0], items: [{ omsOrderLineId: 102, quantity: 1 }] },
      ],
    };
    await expect(store.persist(request)).resolves.toMatchObject({
      replayed: false,
    });
  });

  it("blocks uncorrelated order-wide inventory history for every selection", async () => {
    await pool.query(
      `INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id) VALUES('return',1,201)`,
    );
    await expect(store.persist(preparedIntake())).rejects.toMatchObject({
      code: "RETURN_INTAKE_SOURCE_CHANGED",
    });
  });

  it("blocks ambiguous Shopify refund physical projections across WMS partitions and records one durable review issue", async () => {
    await store.persist(partialIntake());
    const project = () =>
      drizzle(pool).transaction((tx) =>
        refundCascadeTest.createExpectedReturn(tx, {
          omsOrderId: 100,
          wmsOrderId: 202,
          refundExternalId: "refund-test",
          refundPayload: {},
          now: INTAKE_NOW,
          adjustments: [
            {
              externalLineItemId: "500",
              quantity: 1,
              restockPolicy: "return",
              raw: {},
            },
          ],
          wmsItems: [
            {
              id: 302,
              omsOrderLineId: 101,
              externalLineItemId: "500",
              quantity: 1,
              pickedQuantity: 1,
              fulfilledQuantity: 1,
              status: "completed",
              authorityFulfillableQuantity: 0,
              requiresShipping: true,
              manualReviewReason: null,
            },
          ],
        }),
      );
    expect(await project()).toMatchObject({
      returnId: null,
      itemsCreated: 0,
      warnings: [expect.stringContaining("requires correlation")],
    });
    await project();
    expect((await counts()).items).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT rule,details FROM wms.reconciliation_exceptions`,
        )
      ).rows,
    ).toEqual([
      {
        rule: "portal_refund_rma_correlation",
        details: expect.objectContaining({
          omsOrderLineId: 101,
          physicalReturnProjectionBlocked: true,
          financialRefundIngestionBlocked: false,
        }),
      },
    ]);
  });

  it("routes portal-owned purchased lines to canonical receipt across partitions while preserving unrelated legacy routing", async () => {
    await store.persist(partialIntake());
    // Stop at the inventory boundary: this test proves the real SQL fence and
    // transaction path, while unit coverage verifies the legacy stock calls.
    const legacy = createReturnsService(drizzle(pool), {
      withTx: () => {
        throw new Error("UNRELATED_LEGACY_RECEIVING_REACHED");
      },
    });
    await expect(
      legacy.processReturn({
        orderId: 202,
        warehouseLocationId: 1,
        items: [
          {
            orderItemId: 302,
            productVariantId: 501,
            qty: 1,
            condition: "sellable",
          },
        ],
      }),
    ).rejects.toThrow("RETURN_CANONICAL_RECEIVING_REQUIRED");
    await expect(
      legacy.processReturn({
        orderId: 202,
        warehouseLocationId: 1,
        items: [
          {
            orderItemId: 303,
            productVariantId: 502,
            qty: 1,
            condition: "sellable",
          },
        ],
      }),
    ).rejects.toThrow("UNRELATED_LEGACY_RECEIVING_REACHED");
    expect(
      (
        await pool.query(
          `SELECT COUNT(*)::int AS n FROM inventory.inventory_transactions`,
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("concurrent identical requests return one root and its durable parcels", async () => {
    const results = await Promise.all([
      store.persist(preparedIntake()),
      store.persist(preparedIntake()),
    ]);
    expect(new Set(results.map((result) => result.authorizationId)).size).toBe(
      1,
    );
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(await counts()).toEqual({
      roots: 1,
      cases: 2,
      items: 3,
      parcels: 2,
    });
  });

  it("a competing command cannot claim quantities committed by the first", async () => {
    const key = "00000000-0000-4000-8000-000000000003";
    await seedIntakeSubmission(pool, key, INTAKE_LEASE);
    const outcomes = await Promise.allSettled([
      store.persist(preparedIntake()),
      store.persist({ ...preparedIntake(), idempotencyKey: key }),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await counts()).toEqual({
      roots: 1,
      cases: 2,
      items: 3,
      parcels: 2,
    });
  });

  it("replays saved results after intake is paused without creating another case", async () => {
    const first = await store.persist(preparedIntake());
    await pool.query(
      "UPDATE returns.customer_return_settings SET enabled=false,version=2",
    );
    expect(await store.persist(preparedIntake())).toEqual({
      ...first,
      replayed: true,
    });
    await expect(
      store.find({ ...preparedIntake(), semanticHash: "c".repeat(64) }),
    ).rejects.toMatchObject({ code: "RETURN_LABEL_COMMAND_CONFLICT" });
    await expect(
      store.find({ ...preparedIntake(), omsOrderId: 200 }),
    ).rejects.toMatchObject({ code: "RETURN_LABEL_COMMAND_CONFLICT" });
  });

  it.each(["paused", "version", "carrier", "warehouse", "policy"])(
    "rejects changed %s configuration without effects",
    async (kind) => {
      if (kind === "paused")
        await pool.query(
          "UPDATE returns.customer_return_settings SET enabled=false",
        );
      if (kind === "version")
        await pool.query(
          "UPDATE returns.customer_return_settings SET version=2",
        );
      if (kind === "carrier")
        await pool.query(
          "UPDATE returns.customer_return_settings SET carrier_id='se-456'",
        );
      if (kind === "warehouse")
        await pool.query("UPDATE warehouse.warehouses SET is_active=0");
      if (kind === "policy")
        await pool.query("UPDATE returns.return_policies SET status='retired'");
      await expect(store.persist(preparedIntake())).rejects.toMatchObject({
        code: "RETURN_LABEL_SETTINGS_CHANGED",
      });
      expect(await counts()).toEqual({
        roots: 0,
        cases: 0,
        items: 0,
        parcels: 0,
      });
    },
  );

  it.each(["token", "expiry", "rejected", "hash", "actor"])(
    "fences a changed submission %s",
    async (kind) => {
      if (kind === "token")
        await pool.query(
          "UPDATE returns.customer_return_submission_commands SET lease_token='00000000-0000-4000-8000-000000000099'",
        );
      if (kind === "expiry")
        await pool.query(
          "UPDATE returns.customer_return_submission_commands SET lease_until=$1",
          [INTAKE_NOW],
        );
      if (kind === "rejected")
        await pool.query(
          "UPDATE returns.customer_return_submission_commands SET status='rejected'",
        );
      if (kind === "actor")
        await pool.query(
          "UPDATE returns.customer_return_submission_commands SET lease_actor='admin:other'",
        );
      const request = preparedIntake();
      if (kind === "hash") request.semanticHash = "c".repeat(64);
      await expect(store.persist(request)).rejects.toMatchObject({
        code: "RETURN_LABEL_SUBMISSION_LEASE_CHANGED",
      });
      expect((await counts()).roots).toBe(0);
    },
  );

  it("rolls back root, claims, child cases, boxes and acceptance on a late persistence failure", async () => {
    await pool.query(`CREATE FUNCTION returns.fail_second_parcel() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.parcel_key='2' THEN RAISE EXCEPTION 'synthetic parcel failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_second_parcel BEFORE INSERT ON returns.customer_return_parcels FOR EACH ROW EXECUTE FUNCTION returns.fail_second_parcel()`);
    try {
      await expect(store.persist(preparedIntake())).rejects.toThrow(
        "synthetic parcel failure",
      );
      expect(await counts()).toEqual({
        roots: 0,
        cases: 0,
        items: 0,
        parcels: 0,
      });
      expect(
        (
          await pool.query(
            "SELECT status FROM returns.customer_return_submission_commands",
          )
        ).rows[0].status,
      ).toBe("preparing");
    } finally {
      await pool.query(
        "DROP TRIGGER fail_second_parcel ON returns.customer_return_parcels; DROP FUNCTION returns.fail_second_parcel()",
      );
    }
  });

  it("rejects overpacking, stale claims, unknown identities and source staleness without effects", async () => {
    const invalidBox = preparedIntake();
    invalidBox.parcels[0].items[0].quantity = 3;
    await expect(store.persist(invalidBox)).rejects.toMatchObject({
      code: "RETURN_INTAKE_INPUT_INVALID",
    });
    const stale = preparedIntake();
    stale.expectedClaims[0].claimedQuantity = 1;
    await expect(store.persist(stale)).rejects.toMatchObject({
      code: "RETURN_INTAKE_SOURCE_CHANGED",
    });
    const identity = preparedIntake();
    identity.lines[0].externalLineItemId = "gid://shopify/LineItem/500";
    await expect(store.persist(identity)).rejects.toThrow();
    await expect(
      store.persist({
        ...preparedIntake(),
        observedAt: new Date(INTAKE_NOW.getTime() - 120_001).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "RETURN_INTAKE_SOURCE_CHANGED" });
    expect(await counts()).toEqual({
      roots: 0,
      cases: 0,
      items: 0,
      parcels: 0,
    });
  });

  it("keeps manifests, links and case ownership immutable", async () => {
    await store.persist(preparedIntake());
    await expect(
      pool.query("UPDATE returns.customer_return_parcels SET weight_grams=1"),
    ).rejects.toThrow("append-only");
    await expect(
      pool.query("DELETE FROM returns.customer_return_allocation_case_items"),
    ).rejects.toThrow("append-only");
    await expect(
      pool.query("UPDATE returns.return_cases SET source_provider='admin'"),
    ).rejects.toThrow("immutable");
  });

  it("rejects incomplete committed manifests at the deferred database boundary", async () => {
    const result = await store.persist(preparedIntake());
    await expect(
      pool.query(
        `INSERT INTO returns.customer_return_parcels(authorization_id,parcel_key,dimensions,weight_grams,
      origin_address,destination_address,carrier_id,service_code,created_at)
      SELECT authorization_id,'3',dimensions,weight_grams,origin_address,destination_address,carrier_id,service_code,created_at
      FROM returns.customer_return_parcels WHERE id=$1`,
        [result.parcels[0].parcelId],
      ),
    ).rejects.toThrow();
    expect((await counts()).parcels).toBe(2);
  });

  it("refuses a direct financial reservation for a portal case at the database boundary", async () => {
    const result = await store.persist(preparedIntake());
    await expect(
      pool.query(
        `INSERT INTO returns.return_case_customer_refunds(return_case_id,channel_id,provider,external_order_id,currency,
      amount_cents,maximum_refundable_cents,status,idempotency_key,request_hash,quote_hash,quote,notify_customer,requested_by,requested_at)
      VALUES($1,36,'shopify','1000','USD',1,1,'pending','forbidden',$2,$2,'{}',false,'test',$3)`,
        [result.cases[0].caseId, "a".repeat(64), INTAKE_NOW],
      ),
    ).rejects.toThrow("manually in Shopify");
  });
});
