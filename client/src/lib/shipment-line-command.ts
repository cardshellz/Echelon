import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  shipmentLineResourceIdSchema as idSchema, shipmentLineVersionSchema,
  shipmentLineEditableShape, shipmentLinePatchSchema, shipmentLineDeleteSchema,
  shipmentLineFromPoSchema, shipmentPackingListImportSchema, shipmentLineResolveSchema,
  SHIPMENT_LINE_INTEGER_MAX, type ShipmentLinePatchCommand,
} from "@shared/procurement/shipment-line-command";
import { FinancialCommandRequestError, financialCommandFetchJson } from "./financial-command";

export const shipmentLineCollectionSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("add-from-po"), body: shipmentLineFromPoSchema }).strict(),
  z.object({ operation: z.literal("import"), body: shipmentPackingListImportSchema }).strict(),
  z.object({ operation: z.literal("resolve-dimensions"), body: shipmentLineResolveSchema }).strict(),
]);
export type ShipmentLineCollection = z.infer<typeof shipmentLineCollectionSchema>;
const shipmentLineCommandSchema = z.union([shipmentLineCollectionSchema,
  z.object({ operation: z.literal("update"), lineId: idSchema, body: shipmentLinePatchSchema }).strict(),
  z.object({ operation: z.literal("delete"), lineId: idSchema, body: shipmentLineDeleteSchema }).strict(),
]);
export type ShipmentLineCommand = z.infer<typeof shipmentLineCommandSchema>;
type LineCommand = ShipmentLineCommand;
const keySchema = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
const recoverySchema = z.object({ schemaVersion: z.literal(1), userId: z.string().min(1), shipmentId: idSchema,
  key: keySchema, command: shipmentLineCommandSchema }).strict();
export type ShipmentLineRecovery = z.infer<typeof recoverySchema>;
type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** One unresolved line change per user/shipment; persist before dispatch. */
export function createShipmentLineRecoveryStore(storage: () => SessionStorage, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before changing shipment lines.");
  const storageKey = (id: number) => `echelon:shipment-lines:v1:${encodeURIComponent(userId)}:${idSchema.parse(id)}`;
  function read(shipmentId: number): ShipmentLineRecovery | null {
    let raw: string | null;
    try { raw = storage().getItem(storageKey(shipmentId)); }
    catch { throw new Error("Saved line commands cannot be read. Restore browser session storage before changing shipment lines."); }
    if (!raw) return null;
    const parsed = (() => { try { return recoverySchema.safeParse(JSON.parse(raw)); } catch { return null; } })();
    if (!parsed?.success || parsed.data.userId !== userId || parsed.data.shipmentId !== shipmentId) {
      throw new Error("A saved shipment line command cannot be verified. Recover the original command before adding or importing lines.");
    }
    return parsed.data;
  }
  return {
    userId,
    read,
    acquire(shipmentId: number, command: ShipmentLineCommand, generateKey: () => string) {
      const existing = read(shipmentId);
      if (existing) {
        if (canonicalJson(existing.command) !== canonicalJson(command)) throw new Error("An earlier line command is unresolved. Retry its original request before starting another line change.");
        return existing;
      }
      const record = recoverySchema.parse({ schemaVersion: 1, userId, shipmentId, key: generateKey(), command });
      try { storage().setItem(storageKey(shipmentId), JSON.stringify(record)); }
      catch { throw new Error("The line command was not sent because its recovery key could not be saved. Restore browser session storage and try again."); }
      return record;
    },
    complete(shipmentId: number, key: string) {
      if (read(shipmentId)?.key !== key) return;
      try { storage().removeItem(storageKey(shipmentId)); }
      catch { throw new Error("The line command finished, but its recovery key could not be cleared. Retry the original command to confirm and clear it safely."); }
    },
  };
}
export type ShipmentLineRecoveryStore = ReturnType<typeof createShipmentLineRecoveryStore>;
const savedLineSchema = z.object({ id: idSchema, inboundShipmentId: idSchema, version: shipmentLineVersionSchema }).passthrough();
export const shipmentLineImportResultSchema = z.object({ imported: z.number().int().nonnegative(),
  errors: z.array(z.object({ row: z.number().int().positive(), error: z.string(), code: z.string().optional() })),
  lines: z.array(savedLineSchema) });
export type ShipmentLineImportResult = z.infer<typeof shipmentLineImportResultSchema>;
export type ShipmentLineCommandResult = { operation: "add-from-po"; lines: z.infer<typeof savedLineSchema>[] }
  | { operation: "import"; result: ShipmentLineImportResult }
  | { operation: "resolve-dimensions"; updated: number; total: number }
  | { operation: "update"; line: z.infer<typeof savedLineSchema> }
  | { operation: "delete" };

function validateResult(command: LineCommand, shipmentId: number, raw: unknown): ShipmentLineCommandResult {
  function linesMatch(lines: z.infer<typeof savedLineSchema>[]) {
    if (lines.some((line) => line.inboundShipmentId !== shipmentId) || new Set(lines.map((line) => line.id)).size !== lines.length) throw new Error("Shipment line response identity mismatch");
  }
  if (command.operation === "delete") { z.object({ success: z.literal(true) }).parse(raw); return { operation: "delete" }; }
  if (command.operation === "update") {
    const line = savedLineSchema.parse(raw); linesMatch([line]);
    if (line.id !== command.lineId) throw new Error("Updated line identity mismatch");
    return { operation: "update", line };
  }
  if (command.operation === "resolve-dimensions") {
    const result = z.object({ updated: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).parse(raw);
    if (result.updated > result.total) throw new Error("Resolved count exceeds total");
    return { operation: "resolve-dimensions", ...result };
  }
  if (command.operation === "add-from-po") { const lines = z.array(savedLineSchema).parse(raw); linesMatch(lines); return { operation: "add-from-po", lines }; }
  const result = shipmentLineImportResultSchema.parse(raw);
  linesMatch(result.lines);
  const rejected = new Set(result.errors.map((error) => error.row));
  if (result.imported !== result.lines.length || rejected.size !== result.errors.length
    || result.imported + rejected.size !== command.body.rows.length
    || result.errors.some((error) => error.row > command.body.rows.length)) throw new Error("Import result does not account for every submitted row");
  return { operation: "import", result };
}

/** Explicit state: unresolved per-line requests also freeze their body, preventing blind rebases. */
export function createShipmentLineCommandClient(generateKey: () => string, recoveryStore: ShipmentLineRecoveryStore) {
  const pending = new Map<string, { fingerprint: string; key: string }>();
  return {
    async execute(shipmentIdInput: number, input: LineCommand, pinnedRecovery?: ShipmentLineRecovery): Promise<ShipmentLineCommandResult> {
      const shipmentId = idSchema.parse(shipmentIdInput);
      const command: LineCommand = input.operation === "update"
        ? { operation: input.operation, lineId: idSchema.parse(input.lineId), body: shipmentLinePatchSchema.parse(input.body) }
        : input.operation === "delete" ? { operation: input.operation, lineId: idSchema.parse(input.lineId), body: shipmentLineDeleteSchema.parse(input.body) }
        : shipmentLineCollectionSchema.parse(input);
      const collection = command.operation !== "update" && command.operation !== "delete";
      const suffix = command.operation === "add-from-po" ? "from-po" : command.operation === "import" ? "import-packing-list" : command.operation;
      const url = collection ? `/api/inbound-shipments/${shipmentId}/lines/${suffix}` : `/api/inbound-shipments/lines/${command.lineId}`;
      const method = collection ? "POST" : command.operation === "update" ? "PATCH" : "DELETE";
      const identity = `${method}:${url}`;
      const fingerprint = canonicalJson(command);
      const previous = pending.get(identity);
      if (previous && previous.fingerprint !== fingerprint) throw new Error("This line has an unresolved command. Retry the original request before changing its values.");
      if (pinnedRecovery) {
        const pinned = recoverySchema.parse(pinnedRecovery);
        if (pinned.shipmentId !== shipmentId || pinned.userId !== recoveryStore.userId || canonicalJson(pinned.command) !== fingerprint) {
          throw new Error("The saved command does not match this user, shipment, and request.");
        }
      }
      // A delayed response can clear storage while a later visit still displays its
      // recovery card. Pin that card's original key even when storage is now empty.
      const recovery = recoveryStore.acquire(shipmentId, command, pinnedRecovery ? () => pinnedRecovery.key : generateKey);
      if (pinnedRecovery && recovery.key !== pinnedRecovery.key) throw new Error("A different line command now requires recovery. Reload this shipment before retrying.");
      const key = recovery?.key ?? previous?.key ?? keySchema.parse(generateKey());
      pending.set(identity, { fingerprint, key });
      try {
        const raw = await financialCommandFetchJson<unknown>(url, { method, credentials: "include",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(command.body) });
        let result: ShipmentLineCommandResult;
        try { result = validateResult(command, shipmentId, raw); }
        catch (cause) { throw new FinancialCommandRequestError("The line command may have completed, but its response could not be verified. Retry the original command.", {
          status: 200, code: "SHIPMENT_LINE_RESPONSE_INVALID", retryable: true, ambiguous: true, cause }); }
        if (recovery) {
          try { recoveryStore.complete(shipmentId, key); }
          catch (cause) { throw new FinancialCommandRequestError(cause instanceof Error ? cause.message : "Recovery storage failed", {
            status: 200, code: "SHIPMENT_LINE_RECOVERY_STORAGE_FAILED", retryable: true, ambiguous: true, cause }); }
        }
        pending.delete(identity);
        return result;
      } catch (error) {
        if (!(error instanceof FinancialCommandRequestError && error.ambiguous)) {
          pending.delete(identity);
          if (recovery) {
            try { recoveryStore.complete(shipmentId, key); }
            catch (cause) { throw new FinancialCommandRequestError(cause instanceof Error ? cause.message : "Recovery storage failed", {
              status: null, code: "SHIPMENT_LINE_RECOVERY_STORAGE_FAILED", retryable: true, ambiguous: true, cause }); }
          }
        }
        throw error;
      }
    },
  };
}

const recordedInteger = z.number().int().min(-SHIPMENT_LINE_INTEGER_MAX - 1).max(SHIPMENT_LINE_INTEGER_MAX);
const recordedLineSchema = z.object({ id: idSchema, inboundShipmentId: idSchema, version: shipmentLineVersionSchema,
  qtyShipped: recordedInteger, cartonCount: recordedInteger.nullable(),
  weightKg: z.string().nullable(), lengthCm: z.string().nullable(), widthCm: z.string().nullable(), heightCm: z.string().nullable(),
  notes: z.string().nullable(), sku: z.string().nullable().optional(), unitsPerVariant: z.number().nullable().optional(),
  purchaseOrderId: idSchema.nullable().optional(), purchaseOrderLineId: idSchema.nullable().optional(), productVariantId: idSchema.nullable().optional() });
export const LINE_FORM_FIELDS = ["qtyShipped", "cartonCount", "weightKg", "lengthCm", "widthCm", "heightCm", "notes"] as const;
export type ShipmentLineForm = Record<typeof LINE_FORM_FIELDS[number], string>;
export type ShipmentLineEditor = { id: number; shipmentId: number; version: string; sku: string; livePackReference: number | null;
  sourceIdentity: string; physicalReviewRequired: boolean; original: ShipmentLineForm; form: ShipmentLineForm };
export function shipmentLineEditorFromRecord(input: unknown, shipmentId: number): ShipmentLineEditor {
  const result = recordedLineSchema.safeParse(input);
  if (!result.success || result.data.inboundShipmentId !== shipmentId) throw new Error("Line details are incomplete or belong to another shipment. Refresh before editing.");
  const line = result.data;
  const form = Object.fromEntries(LINE_FORM_FIELDS.map((field) => [field, line[field] == null ? "" : String(line[field])])) as ShipmentLineForm;
  return { id: line.id, shipmentId, version: line.version, sku: line.sku ?? `Line ${line.id}`, livePackReference: line.unitsPerVariant ?? null,
    sourceIdentity: canonicalJson({ purchaseOrderId: line.purchaseOrderId ?? null, purchaseOrderLineId: line.purchaseOrderLineId ?? null, productVariantId: line.productVariantId ?? null, sku: line.sku ?? null }),
    physicalReviewRequired: !z.object(shipmentLineEditableShape).safeParse(line).success,
    original: { ...form }, form };
}
/** Allocation of an earlier batch row may update sibling versions. Adopt only a
 * version whose source identity and every editable value still match the draft. */
export function refreshShipmentLineDraftVersion(editor: ShipmentLineEditor, latest: ShipmentLineEditor): ShipmentLineEditor {
  if (editor.id !== latest.id || editor.shipmentId !== latest.shipmentId || editor.sourceIdentity !== latest.sourceIdentity
    || canonicalJson(editor.original) !== canonicalJson(latest.original)) {
    throw new FinancialCommandRequestError("This line's source, quantity, dimensions, or notes changed. Load its latest values and review your draft.", {
      status: 409, code: "SHIPMENT_LINE_DRAFT_CHANGED", retryable: false, ambiguous: false,
    });
  }
  return { ...editor, version: latest.version };
}
export function updateShipmentLinePayload(editor: ShipmentLineEditor): ShipmentLinePatchCommand {
  const changes: Record<string, unknown> = { expectedVersion: editor.version };
  for (const field of LINE_FORM_FIELDS) {
    if (editor.form[field] === editor.original[field]) continue;
    const raw = editor.form[field].trim();
    changes[field] = field === "qtyShipped" || field === "cartonCount"
      ? (raw === "" && field === "cartonCount" ? null : /^\d+$/.test(raw) ? Number(raw) : raw)
      : field === "notes" ? editor.form[field] || null : raw || null;
  }
  const result = shipmentLinePatchSchema.safeParse(changes);
  if (!result.success) throw new Error(result.error.issues.map((issue) => `${issue.path.join(".") || "Line"}: ${issue.message}`).join("; "));
  return result.data;
}
export function shipmentLineNeedsRefresh(error: unknown): boolean {
  return error instanceof FinancialCommandRequestError && !error.ambiguous && (error.status === 409 || error.status === 404);
}
