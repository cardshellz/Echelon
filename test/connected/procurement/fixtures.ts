import { test as base, expect, type Page, type APIRequestContext } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import pg from "pg";

export interface ConnectedActor { id: string; username: string; password: string; role: string; roleId: number }
interface Ready {
  navigation: { purchaseOrderIds: readonly [number, number]; draftPurchaseOrderId: number; shipmentId: number; goodsInvoiceId: number;
    freightInvoiceId: number; goodsInvoiceCents: number; freightInvoiceCents: number };
  event: "procurement_connected_ready"; url: string; receivingOrderId: number;
  databaseName: string; credentials: { username: string; password: string }; actors: ConnectedActor[];
}
export interface ConnectedState {
  authority: string; receiptStatus: string; receiptNotes: string | null;
  lines: Array<{ id: number; productId: number | null; productVariantId: number | null; expectedQty: number; receivedQty: number;
    damagedQty: number; unitsPerVariantSnapshot: number | null; putawayLocationId: number | null; status: string }>;
  entryAudits: number; receiptTransactions: number; stockReceivedBasePieces: number;
  quantityReceiptCommands: number; quantityReceiptEntries: number; onHandBasePieces: number;
  catalogProducts: Array<Record<string, unknown>>; catalogVariants: Array<Record<string, unknown>>;
}
export interface Backend extends Ready {
  control<T>(path: string, body?: unknown): Promise<T>;
  state(): Promise<ConnectedState>;
}

/** Only runtime essentials and explicit disposable-test configuration cross into
 * the child. Application/provider credentials are never inherited. */
function childEnvironment(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const database = process.env.ECHELON_TEST_DATABASE_URL;
  if (!database || process.env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true") {
    throw new Error("Connected tests require an explicitly disposable PostgreSQL connection");
  }
  return { ...env, NODE_ENV: "test", TZ: "UTC", DISABLE_SCHEDULERS: "true", PG_POOL_MAX: "4",
    ECHELON_TEST_DATABASE_URL: database, ECHELON_TEST_DATABASE_DISPOSABLE: "true", ECHELON_CONNECTED_CONTROL_TOKEN: token };
}

async function control<T>(request: APIRequestContext, ready: Ready, token: string, path: string, body?: unknown): Promise<T> {
  const response = await request.fetch(ready.url + "/__test/" + path, {
    method: body === undefined ? "GET" : "POST", headers: { "X-Connected-Test-Token": token },
    ...(body === undefined ? {} : { data: body }), timeout: 15_000,
  });
  if (!response.ok()) throw new Error("Connected control " + path + " failed: " + response.status() + " " + await response.text());
  return response.json() as Promise<T>;
}

/** The child reports its unique allocation before importing application owners.
 * This fallback touches only that exact owned database after the child exits. */
async function cleanOwnedDatabase(databaseName: string): Promise<boolean> {
  if (!/^inventory_cutover_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Invalid cleanup database identity");
  const url = new URL(process.env.ECHELON_TEST_DATABASE_URL!);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.search
    || process.env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true") throw new Error("Invalid cleanup server identity");
  const admin = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
  await admin.connect();
  try {
    const result = await admin.query<{ owned: boolean }>(
      "SELECT pg_get_userbyid(datdba) = current_user AS owned FROM pg_database WHERE datname=$1", [databaseName]);
    if (result.rowCount === 0) return false;
    if (result.rows[0]?.owned !== true) throw new Error("Refusing to remove a database owned by another role");
    await admin.query('DROP DATABASE "' + databaseName + '" WITH (FORCE)');
    return true;
  } finally { await admin.end(); }
}
export const test = base.extend<{ backend: Backend }>({
  backend: async ({ playwright }, use, info) => {
    const token = randomBytes(32).toString("hex");
    const environment = childEnvironment(token);
    const logPath = info.outputPath("connected-server.log");
    await mkdir(dirname(logPath), { recursive: true });
    const request = await playwright.request.newContext();
    const log = createWriteStream(logPath);
    const child = spawn(process.execPath, ["--import", "tsx", resolve("test/connected/procurement/server.ts")], {
      cwd: process.cwd(), env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    let childExited = false;
    const exited = new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("exit", code => { childExited = true; done(code); });
    });
    const closed = new Promise<void>(done => { child.once("close", () => done()); });
    // Keep the rejection observed even if startup fails before cleanup begins.
    void exited.catch(() => {});
    const lines = createInterface({ input: child.stdout });

    let ready: Ready | undefined;
    let ownedDatabaseName: string | undefined;
    const recordDatabase = (line: string) => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message !== "object" || message === null || !("event" in message)
        || message.event !== "procurement_connected_database" || !("databaseName" in message)) return;
      if (typeof message.databaseName !== "string" || !/^inventory_cutover_[a-f0-9]{32}$/.test(message.databaseName)) {
        return; // Readiness requires a matching, validated allocation below.
      }
      ownedDatabaseName = message.databaseName;
    };
    lines.on("line", recordDatabase);
    try {
      ready = await new Promise<Ready>((done, reject) => {
        const timeout = setTimeout(() => finish(new Error("Connected server startup timed out; see " + logPath)), 120_000);
        const finish = (error?: Error, value?: Ready) => {
          clearTimeout(timeout); child.off("exit", failed); lines.off("line", line);
          if (error) reject(error); else done(value!);
        };
        const failed = (code: number | null) => finish(new Error("Connected server exited " + code + "; see " + logPath));
        const line = (text: string) => {
          if (!text.startsWith("{")) return;
          let value: unknown;
          try { value = JSON.parse(text); } catch { return; }
          if (typeof value === "object" && value !== null && "event" in value && value.event === "procurement_connected_ready") {
            const candidate = value as Ready;
            if (ownedDatabaseName !== candidate.databaseName) { finish(new Error("Connected readiness does not match its allocated database")); return; }
            if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(candidate.url) || !/^inventory_cutover_[a-f0-9]{32}$/.test(candidate.databaseName)) {
              finish(new Error("Invalid connected server readiness identity")); return;
            }
            finish(undefined, candidate);
          }
        };
        child.once("exit", failed); child.once("error", error => finish(error)); lines.on("line", line);
      });
      const active = ready;
      await use({ ...active,
        control: <T>(path: string, body?: unknown) => control<T>(request, active, token, path, body),
        state: () => control<ConnectedState>(request, active, token, "state"),
      });
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        try {
          if (ready && child.exitCode === null) await control(request, ready, token, "shutdown", {});
        } catch (error) { cleanupErrors.push(error); }
        // Always reap the direct Node child, even when the control request fails.
        // A tsx CLI wrapper would make Windows termination miss the real server.
        if (!ready && child.exitCode === null) child.kill("SIGKILL");
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        let exitTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const code = await Promise.race([exited, new Promise<never>((_done, reject) => {
            exitTimer = setTimeout(() => reject(new Error("Connected server did not exit after forced termination")), 25_000);
          })]);
          if (ready && code !== 0) cleanupErrors.push(new Error("Connected server exited " + code));
        } catch (error) { cleanupErrors.push(error); }
        finally { clearTimeout(killTimer); clearTimeout(exitTimer); }
        if (ownedDatabaseName) {
          if (!childExited) {
            cleanupErrors.push(new Error("Connected child exit was not confirmed; database " + ownedDatabaseName
              + " was preserved for process " + String(child.pid) + ". Stop that process before removing its database."));
          } else {
            try {
              const removed = await cleanOwnedDatabase(ownedDatabaseName);
              if (removed) cleanupErrors.push(new Error("Forced cleanup removed a database left by the connected child"));
            } catch (error) { cleanupErrors.push(error); }
          }
        }
        // Exit proves the process stopped; close additionally proves its piped
        // output ended. Ending the log at exit can race buffered stdout/stderr.
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([closed, new Promise<never>((_done, reject) => {
            drainTimer = setTimeout(() => reject(new Error("Connected child output did not close for process "
              + String(child.pid) + "; the server log may be incomplete")), 5_000);
          })]);
        } catch (error) { cleanupErrors.push(error); }
        finally { clearTimeout(drainTimer); }
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Connected cleanup failed; see " + logPath);
      } finally {
        // A drain timeout must also detach the sources before ending the file.
        child.stdout.unpipe(log); child.stderr.unpipe(log);
        lines.close(); await request.dispose();
        await new Promise<void>(done => log.end(done));
        await info.attach("connected-server", { path: logPath, contentType: "text/plain" });
      }
    }
  },
});

export async function login(page: Page, backend: Backend, actor = backend.credentials): Promise<void> {
  await page.goto(backend.url + "/login");
  await page.getByTestId("input-username").fill(actor.username);
  await page.getByTestId("input-password").fill(actor.password);
  await page.getByTestId("button-login").click();
  await expect(page).not.toHaveURL(/\/login$/);
}
export async function prepareCaseReceipt(page: Page, backend: Backend): Promise<void> {
  await page.goto(backend.url + "/receiving?open=" + backend.receivingOrderId);
  await page.getByTestId("btn-add-line").click();
  const dialog = page.getByRole("dialog", { name: "Add Line", exact: true });
  await dialog.getByTestId("input-add-line-sku").fill("P5");
  await dialog.getByTestId("sku-option-P5").click();
  await dialog.getByTestId("input-add-line-expected").fill("5");
  await dialog.getByRole("combobox", { name: "Put-away location", exact: true }).click();
  await page.getByRole("option", { name: /PICK/ }).click();
}
export { expect };
