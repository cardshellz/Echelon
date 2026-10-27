/** Dedicated connected-acceptance entry point. Never imported by server/index. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { z } from "zod";

function checkedConfiguration() {
  if (process.env.NODE_ENV !== "test" || process.env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true") {
    throw new Error("Connected acceptance requires NODE_ENV=test and an explicitly disposable database");
  }
  if (process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL) {
    throw new Error("Strip application database URLs before starting connected acceptance");
  }
  const connectionString = process.env.ECHELON_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("A disposable loopback PostgreSQL URL is required");
  const url = new URL(connectionString);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error("Invalid connected database protocol");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Connected acceptance refuses a non-loopback database");
  if (url.search) throw new Error("Connected acceptance does not allow database URL query overrides");
  const controlToken = process.env.ECHELON_CONNECTED_CONTROL_TOKEN;
  if (!controlToken || controlToken.length < 32) throw new Error("A private parent-process control token of at least 32 characters is required");
  const inheritedProviderKeys = Object.keys(process.env).filter(key => /^(AWS_|SHOPIFY_|EBAY_|STRIPE_|SENDGRID_|MAILGUN_|SHIPSTATION_|WALMART_)/.test(key));
  if (inheritedProviderKeys.length) throw new Error("Strip provider configuration before starting connected acceptance");
  const publicPath = resolve(process.cwd(), "dist/public");
  if (!existsSync(resolve(publicPath, "index.html"))) throw new Error("Build the local frontend before connected acceptance");
  return { connectionString, controlToken, publicPath };
}

async function main(): Promise<void> {
  const configuration = checkedConfiguration();
  // Allocate with the low-level helper before importing any owner/fixture that
  // transitively imports server/db. No application pool sees the admin URL.
  const { createInventoryCutoverTestDatabase } = await import("../../../server/modules/inventory/__tests__/fixtures/inventory-cutover-database");
  const allocatedDatabase = await createInventoryCutoverTestDatabase(configuration.connectionString, true, "");
  const dedicatedUrl = new URL(allocatedDatabase.connectionString);
  if (!/^\/inventory_cutover_[a-f0-9]{32}$/.test(dedicatedUrl.pathname)) {
    await allocatedDatabase.close();
    throw new Error("Unexpected connected fixture database identity");
  }
  console.log(JSON.stringify({ event: "procurement_connected_database", databaseName: dedicatedUrl.pathname.slice(1) }));
  process.env.DATABASE_URL = allocatedDatabase.connectionString;
  process.env.DISABLE_SCHEDULERS = "true";
  let applicationPool: { end(): Promise<void> } | undefined;
  async function endApplicationPool(): Promise<void> {
    const closing = applicationPool;
    applicationPool = undefined;
    await closing?.end();
  }
  // Existing fixture setup cleans up on failure. Close the application pool
  // first in that path as well, so DROP DATABASE cannot leak a fixture database.
  const ownedDatabase = { ...allocatedDatabase, async close() {
    await endApplicationPool();
    await allocatedDatabase.close();
  } };
  let store: InstanceType<ReturnType<typeof connectPgSimple>> | undefined;
  const app = express();
  const server = createServer(app);
  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ event: "procurement_connected_stopping", stage: "http" }));
    if (server.listening) {
      await new Promise<void>((done, reject) => {
        server.close(error => error ? reject(error) : done());
        server.closeIdleConnections();
      });
    }
    console.log(JSON.stringify({ event: "procurement_connected_stopping", stage: "database" }));
    store?.close();
    await ownedDatabase.close();
    console.log(JSON.stringify({ event: "procurement_connected_stopped" }));
  }
  try {
    const { db, pool } = await import("../../../server/db");
    applicationPool = pool;
    const fixture = await import("./server-fixture");
    const context = await fixture.createConnectedReceivingDatabase(ownedDatabase);
    const identity = await pool.query("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== dedicatedUrl.pathname.slice(1)) throw new Error("Application connection escaped its owned fixture database");
    const { ReceivingService } = await import("../../../server/modules/procurement/receiving.service");
    const { createPurchasingService } = await import("../../../server/modules/procurement/purchasing.service");
    const { createShipmentTrackingService } = await import("../../../server/modules/procurement/shipment-tracking.service");
    const navigation = await import("./navigation-fixture");
    const { procurementStorage } = await import("../../../server/modules/procurement");
    const { catalogStorage } = await import("../../../server/modules/catalog");
    const { warehouseStorage } = await import("../../../server/modules/warehouse");
    const { InventoryUseCases } = await import("../../../server/modules/inventory/application/inventory.use-cases");
    const { createInventoryMethods } = await import("../../../server/modules/inventory/infrastructure/inventory.repository");
    const { InventoryLotService } = await import("../../../server/modules/inventory/lots.service");
    const { ReceiptReversalService } = await import("../../../server/modules/procurement/receipt-reversal.service");
    const { ReceiveValidationService } = await import("../../../server/modules/procurement/receive-validation.service");
    const storage = { ...procurementStorage, ...catalogStorage, ...warehouseStorage };
    const inventory = new InventoryUseCases(db as unknown as ConstructorParameters<typeof InventoryUseCases>[0],
      createInventoryMethods(db), new InventoryLotService(db));
    const purchasing = createPurchasingService(db, storage as unknown as Parameters<typeof createPurchasingService>[1],
      { now: () => new Date(fixture.CONNECTED_TIME) });
    const receiveValidation = new ReceiveValidationService(db);
    const channelRequests: number[] = [];
    // Provider dispatch is an explicit inert external boundary. All receiving,
    // quantity, cost-origin, permission and command owners below remain real.
    const receiving = new ReceivingService(db, inventory, {
      queueSyncAfterInventoryChange: async variantId => { channelRequests.push(variantId); },
    }, storage as unknown as ConstructorParameters<typeof ReceivingService>[3], purchasing,
    null, null, null, receiveValidation, null, () => new Date(fixture.CONNECTED_TIME));
    const shipmentTracking = createShipmentTrackingService(db, storage as unknown as Parameters<typeof createShipmentTrackingService>[1],
      undefined, () => new Date(fixture.CONNECTED_TIME));
    const services = { receiving, purchasing, shipmentTracking, receiveValidation, receiptReversal: new ReceiptReversalService(db, inventory) };
    app.locals.services = services as typeof app.locals.services;
    app.use(express.json());
    const PgSession = connectPgSimple(session);
    store = new PgSession({ pool, schemaName: "identity", tableName: "session", createTableIfMissing: true, pruneSessionInterval: false });
    // Force the real store's table initialization before readiness/readback.
    await new Promise<void>((done, reject) => store!.get("connected-fixture-initialization", error => error ? reject(error) : done()));
    app.use(session({ store, secret: configuration.controlToken, resave: false, saveUninitialized: false,
      cookie: { secure: false, httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 } }));
    app.use("/__test", (req, res, next) => {
      const supplied = Buffer.from(req.header("X-Connected-Test-Token") ?? "");
      const expected = Buffer.from(configuration.controlToken);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(403).json({ error: "Invalid connected-test control token" });
      next();
    });
    app.get("/__test/state", async (_req, res, next) => {
      try { res.json({ ...await fixture.readConnectedReceivingState(context.pool), channelRequests }); }
      catch (error) { next(error); }
    });
    app.post("/__test/catalog-variant-failure", async (req, res, next) => {
      const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Specify a boolean enabled" });
      try {
        // A real PostgreSQL failure at the second catalog write proves rollback.
        // This fixture-only fault is restricted to one synthetic SKU.
        await context.pool.query(`CREATE OR REPLACE FUNCTION catalog.connected_reject_variant() RETURNS trigger AS $$
          BEGIN
            IF NEW.sku = 'ROLLBACK-C7' THEN
              RAISE EXCEPTION 'Synthetic connected variant insertion failure' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
          END;
        $$ LANGUAGE plpgsql;
        DROP TRIGGER IF EXISTS connected_reject_variant ON catalog.product_variants;`
          + (parsed.data.enabled ? `CREATE TRIGGER connected_reject_variant BEFORE INSERT ON catalog.product_variants
            FOR EACH ROW EXECUTE FUNCTION catalog.connected_reject_variant();` : ""));
        res.json({ enabled: parsed.data.enabled, sku: "ROLLBACK-C7" });
      } catch (error) { next(error); }
    });
    app.get("/__test/navigation-state", async (_req, res, next) => {
      try { res.json(await navigation.readConnectedNavigationState(context.pool)); }
      catch (error) { next(error); }
    });
    app.post("/__test/expire-sessions", async (_req, res, next) => {
      try { await pool.query("DELETE FROM identity.session"); res.json({ expired: true }); }
      catch (error) { next(error); }
    });
    app.post("/__test/receiving-grant", async (req, res, next) => {
      const parsed = z.object({ actorId: z.string(), allowed: z.boolean() }).strict().safeParse(req.body);
      const actor = parsed.success ? fixture.CONNECTED_ACTORS.find(candidate => candidate.id === parsed.data.actorId) : undefined;
      if (!parsed.success || !actor || actor.id === "connected-admin") {
        return res.status(400).json({ error: "Specify a seeded non-admin actor and boolean allowed" });
      }
      try {
        // Every seeded actor owns a separate role; this test-only grant change
        // cannot accidentally change another actor's authority or permissions.
        if (parsed.data.allowed) {
          await pool.query(`INSERT INTO identity.auth_role_permissions(role_id,permission_id)
            SELECT $1,1 WHERE NOT EXISTS(SELECT 1 FROM identity.auth_role_permissions WHERE role_id=$1 AND permission_id=1)`, [actor.roleId]);
        } else {
          await pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1 AND permission_id=1", [actor.roleId]);
        }
        res.json({ actorId: actor.id, permission: "inventory:adjust", allowed: parsed.data.allowed });
      } catch (error) { next(error); }
    });
    app.post("/__test/shutdown", (_req, res) => {
      res.json({ stopping: true });
      res.once("finish", () => { void stop().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); });
    });
    const { registerAuthRoutes } = await import("../../../server/modules/identity/identity.routes");
    const { registerPurchasingRoutes } = await import("../../../server/modules/procurement/procurement.routes");
    const { registerWarehouseRoutes } = await import("../../../server/modules/warehouse/warehouse.routes");
    const { registerSettingsRoutes } = await import("../../../server/modules/warehouse/settings.routes");
    const { registerProductRoutes } = await import("../../../server/modules/catalog/catalog.routes");
    const { registerInventoryRoutes } = await import("../../../server/modules/inventory/inventory.routes");
    const { registerNotificationRoutes } = await import("../../../server/modules/notifications/notifications.routes");
    registerAuthRoutes(app);
    registerPurchasingRoutes(app);
    registerWarehouseRoutes(app);
    registerSettingsRoutes(app);
    await registerProductRoutes(app);
    registerInventoryRoutes(app);
    registerNotificationRoutes(app);
    app.use("/api", (req, res) => { res.status(404).json({ error: "API is outside this connected fixture", path: req.path }); });
    app.use(express.static(configuration.publicPath));
    app.get("*", (_req, res) => res.sendFile(resolve(configuration.publicPath, "index.html")));
    const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
      console.error("Connected fixture request failed", error);
      res.status(500).json({ error: "Connected fixture request failed" });
    };
    app.use(onError);
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); done(); });
    });
    const address = server.address() as AddressInfo;
    console.log(JSON.stringify({ event: "procurement_connected_ready", url: `http://127.0.0.1:${address.port}`,
      receivingOrderId: 50, databaseName: dedicatedUrl.pathname.slice(1),
      navigation: navigation.CONNECTED_NAVIGATION,
      credentials: { username: "connected-receiver", password: fixture.CONNECTED_PASSWORD },
      actors: fixture.CONNECTED_ACTORS.map(actor => ({ ...actor, password: fixture.CONNECTED_PASSWORD })) }));
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
      void stop().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    });
  } catch (error) {
    await stop();
    throw error;
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
