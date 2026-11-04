import { z } from "zod";
export const customerAccountPageConfigSchema = z
  .object({
    themeId: z
      .string()
      .max(30)
      .regex(/^[1-9][0-9]*$/),
    customerId: z
      .string()
      .max(30)
      .regex(/^[1-9][0-9]*$/),
    loginPath: z
      .string()
      .max(100)
      .regex(/^\/(?:[a-z]{2}(?:-[a-z0-9]{2,8})?\/)?account\/login$/i)
      .default("/account/login"),
    proxyPath: z
      .string()
      .regex(/^\/(apps|a|community|tools)\/[a-z0-9][a-z0-9-]*$/)
      .refine((path) => !path.endsWith("/member-portal")),
  })
  .strict();
export type CustomerAccountPageConfig = z.input<
  typeof customerAccountPageConfigSchema
>;
