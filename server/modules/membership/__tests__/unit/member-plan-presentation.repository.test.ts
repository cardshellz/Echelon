import { describe, expect, it, vi } from "vitest";
import type { MemberDirectoryQueryClient } from "../../infrastructure/member-directory.repository";
import { PgMemberPlanPresentationReader } from "../../infrastructure/member-plan-presentation.repository";

const planId = "5f966934-9ff2-4966-9e8f-d4292ca3290e";
const row = {
  id: planId,
  name: "Internal club name",
  storefront_name: ".club",
  storefront_badge_text: ".club",
  member_price_color: "#4A8A3A",
  primary_color: "#4A8A3A",
  pill_right_bg: "#2b362c",
  icon_url: "https://static.example.invalid/club.png",
};
function harness(rows: unknown[] = [row]) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows }));
  const reader = new PgMemberPlanPresentationReader({
    query,
  } as MemberDirectoryQueryClient);
  return { query, reader };
}
describe("existing storefront member plan presentation", () => {
  it("reads only the resolved plan's existing display fields with a parameterized query", async () => {
    const h = harness();
    expect(await h.reader.read(planId)).toEqual({
      planId,
      name: ".club",
      badgeText: ".club",
      memberPriceColor: "#4A8A3A",
      primaryColor: "#4A8A3A",
      iconUrl: row.icon_url,
    });
    expect(h.query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("FROM membership.plans"),
      [planId],
    );
    const sql = h.query.mock.calls[0][0] as string;
    expect(sql).toContain("is_active = TRUE");
    expect(sql).not.toMatch(
      /INSERT|UPDATE|DELETE|membership\.members|subscriptions/i,
    );
    expect(sql).not.toContain(planId);
  });
  it("uses the storefront's configured name, badge and price-color fallbacks", async () => {
    const h = harness([
      {
        ...row,
        storefront_name: null,
        storefront_badge_text: null,
        member_price_color: null,
        icon_url: null,
      },
    ]);
    expect(await h.reader.read(planId)).toMatchObject({
      name: row.name,
      badgeText: row.name,
      memberPriceColor: row.pill_right_bg,
      iconUrl: null,
    });
  });
  it.each(
    [
      [],
      [row, row],
      [{ ...row, id: "14d8698f-09d8-4dea-8089-fa9a1ec0fb28" }],
      [{ ...row, member_price_color: "red; background:url(javascript:evil)" }],
      [{ ...row, icon_url: "javascript:evil" }],
      [{ ...row, icon_url: "https://user:secret@example.invalid/icon.png" }],
      [{ ...row, storefront_name: "", name: "", storefront_badge_text: "" }],
    ].map((rows) => ({ rows })),
  )(
    "classifies missing, duplicate, foreign or unsafe plan settings: %j",
    async ({ rows }) => {
      await expect(harness(rows).reader.read(planId)).rejects.toMatchObject({
        code: "MEMBERSHIP_PRESENTATION_UNAVAILABLE",
      });
    },
  );
  it("allows the existing embedded image format without HTML execution", async () => {
    const icon = "data:image/svg+xml;base64,PHN2Zy8+";
    expect(
      await harness([{ ...row, icon_url: icon }]).reader.read(planId),
    ).toMatchObject({ iconUrl: icon });
  });
  it.each(["", "not-a-uuid", "' OR true; --"])(
    "validates the already-selected plan before any query: %s",
    async (id) => {
      const h = harness();
      await expect(h.reader.read(id)).rejects.toMatchObject({
        code: "MEMBERSHIP_PRESENTATION_UNAVAILABLE",
        reason: "INVALID_PLAN_ID",
      });
      expect(h.query).not.toHaveBeenCalled();
    },
  );
  it("classifies a failed read without returning its database details", async () => {
    const h = harness();
    h.query.mockRejectedValueOnce(new Error("synthetic database details"));
    await expect(h.reader.read(planId)).rejects.toMatchObject({
      code: "MEMBERSHIP_PRESENTATION_UNAVAILABLE",
      reason: "READ_FAILED",
    });
  });
});
