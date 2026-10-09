import { z } from "zod";
import { memberPlanPresentationSchema } from "@shared/membership/member-plan-presentation";
import {
  MemberPlanPresentationError,
  type MemberPlanPresentationReader,
} from "../application/member-plan-presentation";
import type { MemberDirectoryQueryClient } from "./member-directory.repository";

type PresentationRow = {
  id: string;
  name: string;
  storefront_name: string | null;
  storefront_badge_text: string | null;
  member_price_color: string | null;
  primary_color: string | null;
  pill_right_bg: string | null;
  icon_url: string | null;
};

/** Reads the same plan fields used by shellz-club-app's storefront member-pricing response. */
export class PgMemberPlanPresentationReader
  implements MemberPlanPresentationReader
{
  constructor(private readonly client: MemberDirectoryQueryClient) {}
  async read(rawPlanId: string) {
    const identity = z.string().uuid().safeParse(rawPlanId);
    if (!identity.success)
      throw new MemberPlanPresentationError("INVALID_PLAN_ID");
    const planId = identity.data;
    let result: { rows: PresentationRow[] };
    try {
      result = await this.client.query<PresentationRow>(
        `SELECT id::text, name, storefront_name, storefront_badge_text,
               member_price_color, primary_color, pill_right_bg, icon_url
        FROM membership.plans WHERE id::text = $1 AND is_active = TRUE`,
        [planId],
      );
    } catch {
      // Classify the failed read without exposing a connection string or SQL error to a customer.
      throw new MemberPlanPresentationError("READ_FAILED");
    }
    if (result.rows.length !== 1)
      throw new MemberPlanPresentationError("MISSING_PLAN");
    const row = result.rows[0];
    const parsed = memberPlanPresentationSchema.safeParse({
      planId: row.id,
      name: row.storefront_name || row.name,
      badgeText: row.storefront_badge_text || row.storefront_name || row.name,
      memberPriceColor: row.member_price_color || row.pill_right_bg,
      primaryColor: row.primary_color,
      iconUrl: row.icon_url,
    });
    if (!parsed.success || parsed.data.planId !== planId)
      throw new MemberPlanPresentationError("INVALID_PLAN_CONFIG");
    return parsed.data;
  }
}
