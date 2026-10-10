import { z } from "zod";

export const ebayListingIssueSchema = z.object({
  code: z.string().min(1).max(100),
  title: z.string().min(1).max(160),
  message: z.string().min(1).max(1000),
  nextStep: z.string().min(1).max(1000),
  retryable: z.boolean(),
  action: z.object({
    kind: z.enum(["retry_sync", "check_recovery", "reconnect", "edit_photos", "edit_listing", "review_mapping", "contact_support"]),
    label: z.string().min(1).max(100),
    // Navigation stays inside the application; provider error text cannot supply a URL.
    href: z.string().regex(/^\/(?!\/)[A-Za-z0-9/_?=&.#%-]*$/).max(500).optional(),
  }).strict(),
  reference: z.string().max(240).optional(),
  details: z.array(z.object({ label: z.string().max(100), value: z.string().max(1000) }).strict()).max(25).optional(),
}).strict();
export type EbayListingIssue = z.infer<typeof ebayListingIssueSchema>;
