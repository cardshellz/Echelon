/**
 * The exposure admin view must report the persisted runtime authority, never a
 * literal: after cutover the exposure dials are what publishes, and the page
 * badge is the operator's only signal. Every other query in the view answers
 * empty so the singleton read is the only variable.
 */
import { describe, expect, it, vi } from "vitest";
import { PostgresInventoryChannelExposureAdminStore } from "../../infrastructure/inventory-channel-exposure-admin.repository";

/** Flattens a drizzle `sql` template into text so a fake can route by statement. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((chunk) => {
    if (chunk && typeof chunk === "object" && "queryChunks" in chunk) return sqlText(chunk);
    if (chunk && typeof chunk === "object" && "value" in chunk && Array.isArray((chunk as { value: unknown }).value)) {
      return ((chunk as { value: string[] }).value).join("");
    }
    return "?";
  }).join("");
}

function createStore(authorityRows: unknown[]) {
  const execute = vi.fn(async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes("FROM inventory.availability_runtime_authority")) return { rows: authorityRows };
    return { rows: [] };
  });
  const database = { execute } as unknown as ConstructorParameters<typeof PostgresInventoryChannelExposureAdminStore>[0];
  const shadowStore = {} as ConstructorParameters<typeof PostgresInventoryChannelExposureAdminStore>[1];
  return { store: new PostgresInventoryChannelExposureAdminStore(database, shadowStore), execute };
}

describe("PostgresInventoryChannelExposureAdminStore.getAdminView runtime authority", () => {
  it.each([
    { authority: "legacy", revision: "1" },
    { authority: "canonical", revision: "12" },
  ])("reports the persisted singleton %j instead of asserting legacy", async (row) => {
    const { store, execute } = createStore([row]);

    const view = await store.getAdminView(null);

    expect(view).toMatchObject({
      runtimeAuthority: row.authority,
      runtimeAuthorityRevision: row.revision,
      providerWriteEnabled: false,
    });
    const authorityReads = execute.mock.calls.filter(([query]) => sqlText(query).includes("availability_runtime_authority"));
    expect(authorityReads).toHaveLength(1);
    expect(sqlText(authorityReads[0][0])).toContain("WHERE singleton_key = true");
  });

  it.each([
    { label: "no singleton row", rows: [] },
    { label: "a duplicated singleton", rows: [{ authority: "legacy", revision: "1" }, { authority: "legacy", revision: "1" }] },
    { label: "an unknown authority", rows: [{ authority: "shadow", revision: "1" }] },
    { label: "a zero revision", rows: [{ authority: "legacy", revision: "0" }] },
  ])("refuses the view on $label so no page shows an assumed authority", async ({ rows }) => {
    const { store } = createStore(rows);

    await expect(store.getAdminView(null)).rejects.toMatchObject({
      status: 503,
      code: "INVENTORY_RUNTIME_AUTHORITY_UNAVAILABLE",
    });
  });
});
