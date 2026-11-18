/**
 * Type-only declaration of `rawBody` on incoming HTTP requests.
 *
 * Body-capture middleware stores the exact received bytes here so webhook
 * signature checks can verify them. Every file that reads or writes
 * `request.rawBody` without a cast imports this module with
 * `import type {} from ...`, so the property is declared in any TypeScript
 * program that contains that file, not only in programs that also contain
 * `server/index.ts` (the narrow `tsconfig.order-cancellation-staging.json`
 * program does not).
 *
 * This file has no runtime content. Keep it that way: importers use a
 * type-only import that is erased at build time.
 */
declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

export {};
