import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createMemberResolver } from "../..";

const SERVICES_SRC = readFileSync(
  fileURLToPath(new URL("../../../../services/index.ts", import.meta.url)),
  "utf8",
);

describe("createMemberResolver", () => {
  it("resolves through pooled connections and returns each one", async () => {
    const answers: Record<string, unknown[]> = {
      "FROM membership.members m": [{ member_id: "member-1" }],
      "FROM membership.member_current_membership": [{ subscription_id: "sub-1", plan_id: "plan-club", status: "active" }],
      "FROM membership.plans": [{ plan_id: "plan-club", name: ".club", primary_color: "#2E86DE", priority_modifier: 50 }],
    };
    const release = vi.fn();
    const query = vi.fn(async (text: string) => ({
      rows: Object.entries(answers).find(([marker]) => text.includes(marker))?.[1] ?? [],
    }));
    const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pick<Pool, "connect">;

    const resolution = await createMemberResolver(pool).resolve({ kind: "shopify_customer", shopifyCustomerId: "555" });

    expect(resolution).toMatchObject({ outcome: "member", memberId: "member-1", plan: { planId: "plan-club", priorityModifier: 50 } });
    expect(query).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
  });
});

describe("service wiring", () => {
  it("gives the WMS sync the shared member resolver over the app's pool", () => {
    const wmsSyncConstruction = SERVICES_SRC.slice(SERVICES_SRC.indexOf("new WmsSyncService({"));
    const constructorArgs = wmsSyncConstruction.slice(0, wmsSyncConstruction.indexOf("});"));

    expect(SERVICES_SRC).toContain('import { createMemberResolver } from "../modules/membership";');
    expect(constructorArgs).toContain("memberResolver: createMemberResolver(databasePool),");
  });
});
