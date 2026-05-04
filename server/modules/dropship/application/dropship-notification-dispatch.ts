import type {
  DropshipLogger,
  DropshipNotificationSender,
  DropshipNotificationSenderInput,
} from "./dropship-ports";

export async function sendDropshipNotificationSafely(
  deps: {
    notificationSender?: DropshipNotificationSender;
    logger: DropshipLogger;
  },
  input: DropshipNotificationSenderInput,
  failure: {
    code: string;
    message: string;
    context: Record<string, unknown>;
  },
): Promise<void> {
  if (!deps.notificationSender) {
    return;
  }

  try {
    await deps.notificationSender.send(input);
  } catch (error) {
    deps.logger.warn({
      code: failure.code,
      message: failure.message,
      context: {
        ...failure.context,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export function formatNotificationCurrency(amountCents: number, currency: string): string {
  const dollars = Math.trunc(Math.abs(amountCents) / 100);
  const cents = Math.abs(amountCents) % 100;
  return `${currency.toUpperCase()} ${amountCents < 0 ? "-" : ""}$${dollars}.${String(cents).padStart(2, "0")}`;
}
