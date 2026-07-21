import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureShipStationTrackingWebhook } from "../server/modules/shipping/shipstation-tracking-webhook-registration";
import { createShipStationTrackingWebhooksClient } from "../server/modules/shipping/shipstation-tracking-webhooks.client";
import { resolveShipStationTrackingWebhookSecret } from "../server/modules/shipping/shipstation-tracking-api-config";

interface Flags {
  help: boolean;
  execute: boolean;
  targetUrl: string | null;
  replaceWebhookId: string | null;
  expectedCurrentUrl: string | null;
}

export function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/configure-shipstation-tracking-webhook.ts --dry-run --target-url=https://example.com/api/shipping/webhooks/shipstation/track",
    "  npx tsx scripts/configure-shipstation-tracking-webhook.ts --execute --target-url=https://example.com/api/shipping/webhooks/shipstation/track",
    "  npx tsx scripts/configure-shipstation-tracking-webhook.ts --dry-run --replace-webhook-id=43350 --expected-current-url=https://legacy.example.com/tracking-webhook",
    "  npx tsx scripts/configure-shipstation-tracking-webhook.ts --execute --replace-webhook-id=43350 --expected-current-url=https://legacy.example.com/tracking-webhook",
    "",
    "Environment:",
    "  SHIPSTATION_V2_API_KEY                 Production ShipStation V2 API key.",
    "  SHIPSTATION_TRACKING_WEBHOOK_SECRET    Dedicated callback secret (32-512 printable characters).",
    "  SHIPSTATION_TRACKING_WEBHOOK_URL       Used when --target-url is omitted.",
    "",
    "Dry-run is the default. A takeover requires the exact existing webhook id and URL;",
    "the command also refuses duplicate track subscriptions or existing custom headers.",
  ].join("\n");
}

export function parseFlags(argv: string[]): Flags {
  for (const arg of argv) {
    if (["--help", "-h", "--dry-run", "--execute"].includes(arg)) continue;
    if (arg.startsWith("--target-url=")) continue;
    if (arg.startsWith("--replace-webhook-id=")) continue;
    if (arg.startsWith("--expected-current-url=")) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }
  const targetUrl = argv.find((arg) => arg.startsWith("--target-url="))
    ?.slice("--target-url=".length).trim() || null;
  const replaceWebhookId = argv.find((arg) => arg.startsWith("--replace-webhook-id="))
    ?.slice("--replace-webhook-id=".length).trim() || null;
  const expectedCurrentUrl = argv.find((arg) => arg.startsWith("--expected-current-url="))
    ?.slice("--expected-current-url=".length).trim() || null;
  if (Boolean(replaceWebhookId) !== Boolean(expectedCurrentUrl)) {
    throw new Error("--replace-webhook-id and --expected-current-url must be provided together");
  }
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    execute: argv.includes("--execute"),
    targetUrl,
    replaceWebhookId,
    expectedCurrentUrl,
  };
}

export async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }
  const targetUrl = flags.targetUrl ?? process.env.SHIPSTATION_TRACKING_WEBHOOK_URL?.trim() ?? "";
  if (!targetUrl) {
    throw new Error("--target-url or SHIPSTATION_TRACKING_WEBHOOK_URL is required");
  }
  const result = await configureShipStationTrackingWebhook({
    client: createShipStationTrackingWebhooksClient(),
    targetUrl,
    webhookSecret: resolveShipStationTrackingWebhookSecret(),
    execute: flags.execute,
    takeover: flags.replaceWebhookId && flags.expectedCurrentUrl
      ? { webhookId: flags.replaceWebhookId, currentUrl: flags.expectedCurrentUrl }
      : null,
  });
  console.log(JSON.stringify({ mode: flags.execute ? "execute" : "dry-run", ...result }, null, 2));
  if (result.status === "conflict") process.exitCode = 2;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[ShipStation tracking webhook configuration] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
