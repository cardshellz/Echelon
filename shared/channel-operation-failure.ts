import { z } from "zod";

/** Correlatable evidence without SQL, response bodies, credentials or messages. */
export const channelOperationFailureSchema = z.object({
  category: z.enum(["pool_acquisition_timeout", "database", "unexpected"]),
  errorType: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/),
  codes: z.array(z.string().regex(/^[A-Z0-9_]{1,100}$/)).max(8),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
