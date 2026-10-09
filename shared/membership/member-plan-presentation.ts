import { z } from "zod";

const color = z
  .string()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  .nullable();
const icon = z
  .string()
  .max(512_000)
  .refine((value) => {
    if (
      /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(
        value,
      )
    )
      return true;
    try {
      const url = new URL(value);
      return (
        value.length <= 2048 &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "A safe plan image is required.")
  .nullable();

/** Existing membership plan presentation, shared by consumers without granting benefits. */
export const memberPlanPresentationSchema = z
  .object({
    planId: z.string().uuid(),
    name: z.string().trim().min(1).max(255),
    badgeText: z.string().trim().min(1).max(255),
    memberPriceColor: color,
    primaryColor: color,
    iconUrl: icon,
  })
  .strict();
export type MemberPlanPresentation = z.infer<
  typeof memberPlanPresentationSchema
>;
