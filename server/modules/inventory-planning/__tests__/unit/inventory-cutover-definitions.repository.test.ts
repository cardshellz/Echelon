import { describe, expect, it, vi } from "vitest";
import type { InventoryCutoverDefinitionSelection, InventoryCutoverManifest } from "@shared/types/inventory-cutover-commit";
import type { InventoryAvailabilityTransactionQueryClient } from "../../application/inventory-availability-transaction-query.port";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "../../infrastructure/inventory-cutover-definitions.repository";

const HASH = "a".repeat(64);
const AUDIT = { actor: "operator-1", reason: "Promote the reviewed complete catalog", occurredAt: new Date("2026-09-07T20:00:00.000Z") };
const TABLES = [
  ["model", "1", "transformation_model", "active_model_id", "draft_model_id"],
  ["location_policy", "2", "location_promise_policy", "active_policy_id", "draft_policy_id"],
  ["safety_policy", "business", "promise_safety_policy", "active_policy_id", "draft_policy_id"],
  ["channel_policy", "channel:1", "channel_exposure_policy", "active_policy_id", "draft_policy_id"],
  ["source_binding", "3", "publication_source_binding", "active_binding_id", "draft_binding_id"],
  ["variant_mapping", "3:4", "publication_variant_mapping", "active_mapping_id", "draft_mapping_id"],
] as const;

function manifest(kind: InventoryCutoverDefinitionSelection["kind"] = "model", key = "1"): InventoryCutoverManifest {
  return { contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [1], publicationTargetIds: [3],
    selections: [{ kind, key, definitionId: 10, definitionHash: HASH }] };
}

type Response = { rows: unknown[]; rowCount?: number | null };
function clientWith(responses: Array<Response | Error> = []) {
  const queue = [...responses];
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("Unexpected SQL after scripted evidence");
    return next;
  });
  return { query, client: { query } as unknown as InventoryAvailabilityTransactionQueryClient };
}
const fence = () => ({ rows: [{ epoch: "2" }] });
const head = (draft: number | null = 10, active: number | null = null) => ({ rows: [{ draft_id: draft, active_id: active, revision: "7" }] });
const version = (status = "draft", hash = HASH) => ({ rows: [{ lifecycle_status: status, definition_hash: hash }] });
const write = (count = 1) => ({ rows: [], rowCount: count });

describe("cutover definition promotion owner", () => {
  it.each(TABLES)("promotes reviewed %s using only its allowlisted tables", async (kind, key, table, active, draft) => {
    const { client, query } = clientWith([fence(), head(), version(), write(), write()]);
    await expect(promoteInventoryCutoverDefinitionsInsideTransaction(client, manifest(kind, key), AUDIT)).resolves.toBe(1);
    expect(query.mock.calls[0][0]).toContain("assert_cutover_admission_fence_owner");
    expect(query.mock.calls[1]).toEqual([expect.stringContaining(`inventory.${table}_heads`), [key]]);
    expect(query.mock.calls[1][0]).toContain("FOR UPDATE");
    expect(query.mock.calls[2]).toEqual([expect.stringContaining(`inventory.${table}_versions`), [10]]);
    expect(query.mock.calls[2][0]).toContain("FOR UPDATE");
    expect(query.mock.calls[3]).toEqual([expect.stringContaining("SET lifecycle_status = 'sealed'"), [10, AUDIT.actor, AUDIT.occurredAt.toISOString()]]);
    expect(query.mock.calls[4]).toEqual([expect.stringContaining(`SET ${active} = $2, ${draft} = NULL`), [key, 10, AUDIT.actor, AUDIT.reason, "7"]]);
    expect(query.mock.calls[4][0]).toContain(`AND revision = $5 AND ${draft} = $2`);
    expect(query.mock.calls.some(([sql]) => /\b(BEGIN|COMMIT|ROLLBACK)\b/.test(sql))).toBe(false);
  });

  it("retains an already selected active definition without rewriting audit or revision", async () => {
    const { client, query } = clientWith([fence(), head(null, 10), version("sealed")]);
    await expect(promoteInventoryCutoverDefinitionsInsideTransaction(client, manifest(), AUDIT)).resolves.toBe(0);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it.each([
    { name: "missing head", evidence: [{ rows: [] }] },
    { name: "duplicate head", evidence: [{ rows: [...head().rows, ...head().rows] }] },
    { name: "replaced draft", evidence: [head(11)] },
    { name: "active selected despite newer draft", evidence: [head(11, 10)] },
    { name: "missing definition", evidence: [head(), { rows: [] }] },
    { name: "duplicate definition", evidence: [head(), { rows: [...version().rows, ...version().rows] }] },
    { name: "definition hash changed", evidence: [head(), version("draft", "b".repeat(64))] },
    { name: "sealed draft pointer", evidence: [head(), version("sealed")] },
    { name: "draft active pointer", evidence: [head(null, 10), version("draft")] },
    { name: "retired active pointer", evidence: [head(null, 10), version("retired")] },
  ])("rejects $name before any update", async ({ evidence }) => {
    const { client, query } = clientWith([fence(), ...evidence]);
    await expect(promoteInventoryCutoverDefinitionsInsideTransaction(client, manifest(), AUDIT)).rejects.toMatchObject({
      code: "CUTOVER_REVIEWED_HEAD_CHANGED", context: { kind: "model", key: "1", definitionId: 10 },
    });
    expect(query.mock.calls.some(([sql]) => /^\s*UPDATE/.test(sql))).toBe(false);
  });

  it("propagates a rejected fence before reading any head", async () => {
    const failure = Object.assign(new Error("No exclusive admission ownership"), { code: "55000" });
    const { client, query } = clientWith([failure]);
    await expect(promoteInventoryCutoverDefinitionsInsideTransaction(client, manifest(), AUDIT)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed revision compare and swap so its caller rolls back the earlier seal", async () => {
    const { client, query } = clientWith([fence(), head(), version(), write(), write(0)]);
    await expect(promoteInventoryCutoverDefinitionsInsideTransaction(client, manifest(), AUDIT)).rejects.toMatchObject({ code: "CUTOVER_REVIEWED_HEAD_CHANGED" });
    expect(query).toHaveBeenCalledTimes(5);
    // No independent COMMIT can leave the seal outside the caller's rollback.
    expect(query.mock.calls.some(([sql]) => /\bCOMMIT\b/.test(sql))).toBe(false);
  });

  it("does not swallow a unique violation after earlier transactional writes", async () => {
    const failure = Object.assign(new Error("unique violation"), { code: "23505" });
    const { client } = clientWith([fence(), head(), version(), write(), failure]);
    await expect(promoteInventoryCutoverDefinitionsInsideTransaction(client, manifest(), AUDIT)).rejects.toBe(failure);
  });

  it.each([
    { ...AUDIT, actor: " " }, { ...AUDIT, actor: "x".repeat(101) },
    { ...AUDIT, reason: " " }, { ...AUDIT, reason: "x".repeat(1001) },
    { ...AUDIT, occurredAt: new Date("invalid") },
  ])("rejects invalid audit before admission SQL: %#", async (audit) => {
    const { client, query } = clientWith();
    await expect(promoteInventoryCutoverDefinitionsInsideTransaction(client, manifest(), audit)).rejects.toMatchObject({ code: "CUTOVER_AUDIT_INVALID" });
    expect(query).not.toHaveBeenCalled();
  });

  it("never interpolates a request scope key into SQL", async () => {
    const key = "scope'; DROP TABLE catalog.products; --";
    const { client, query } = clientWith([fence(), head(null, 10), version("sealed")]);
    await promoteInventoryCutoverDefinitionsInsideTransaction(client, manifest("safety_policy", key), AUDIT);
    expect(query.mock.calls[1][0]).not.toContain(key);
    expect(query.mock.calls[1][1]).toEqual([key]);
  });

  it.each([null, undefined, {}, { ...AUDIT, actor: 1 }, { ...AUDIT, reason: [] },
    { ...AUDIT, occurredAt: AUDIT.occurredAt.toISOString() }, { ...AUDIT, unexpected: true },
  ])("classifies malformed audit without throwing a native TypeError: %#", async (audit) => {
    const { client, query } = clientWith();
    await expect(promoteInventoryCutoverDefinitionsInsideTransaction(client, manifest(), audit as never))
      .rejects.toMatchObject({ code: "CUTOVER_AUDIT_INVALID" });
    expect(query).not.toHaveBeenCalled();
  });
});
