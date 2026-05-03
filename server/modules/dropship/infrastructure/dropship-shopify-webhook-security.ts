import { createHmac, timingSafeEqual } from "crypto";

export function verifyShopifyDropshipWebhookHmac(input: {
  rawBody: Buffer;
  hmacHeader: string;
  secrets: readonly string[];
}): boolean {
  for (const secret of input.secrets) {
    if (!secret.trim()) {
      continue;
    }
    const expected = createHmac("sha256", secret).update(input.rawBody).digest("base64");
    if (safeEqual(input.hmacHeader, expected)) {
      return true;
    }
  }
  return false;
}

export function resolveShopifyDropshipWebhookSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    env.DROPSHIP_SHOPIFY_WEBHOOK_SECRET,
    env.SHOPIFY_WEBHOOK_SECRET,
    env.SHOPIFY_API_SECRET,
  ];
  return Array.from(new Set(
    candidates
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  ));
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
