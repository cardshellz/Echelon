import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { recoverStaffPasswordBreakGlass } from "../../server/modules/identity";

export interface BreakGlassCliOptions {
  userId?: string;
  username?: string;
  password: string;
  generatedPassword: boolean;
  reason: string;
  operator: string;
  operationId: string;
}

export function parseBreakGlassCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): BreakGlassCliOptions {
  let userId: string | undefined;
  let username: string | undefined;
  let reason: string | undefined;
  let operator: string | undefined;
  let operationId: string | undefined;
  let generatePassword = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user-id") {
      userId = argv[++i]?.trim();
    } else if (arg === "--username") {
      username = argv[++i]?.trim();
    } else if (arg === "--reason") {
      reason = argv[++i]?.trim();
    } else if (arg === "--operator") {
      operator = argv[++i]?.trim();
    } else if (arg === "--operation-id") {
      operationId = argv[++i]?.trim();
    } else if (arg === "--generate-password") {
      generatePassword = true;
    } else {
      throw new Error(`Unknown CLI option: ${arg}`);
    }
  }

  if (!userId && !username) {
    throw new Error("Specify --username <username> or --user-id <id>.");
  }
  if (!reason || reason.length < 10) {
    throw new Error("Specify --reason \"<at least 10 characters explaining the break-glass recovery>\".");
  }

  const envPassword = env.ECHELON_RECOVERY_TEMP_PASSWORD;
  const password = generatePassword
    ? randomBytes(18).toString("base64url")
    : envPassword ?? "";

  if (!password) {
    throw new Error(
      "Provide a temporary password via ECHELON_RECOVERY_TEMP_PASSWORD or pass --generate-password.",
    );
  }
  if (new TextEncoder().encode(password).length > 72) {
    throw new Error("Temporary password must not exceed 72 UTF-8 bytes.");
  }

  const resolvedOperator =
    operator || env.ECHELON_RECOVERY_OPERATOR?.trim() || env.USER?.trim() || env.USERNAME?.trim() || "cli-operator";

  return {
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
    password,
    generatedPassword: generatePassword,
    reason,
    operator: resolvedOperator,
    operationId: operationId || randomUUID(),
  };
}

export async function runBreakGlassCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  execute: typeof recoverStaffPasswordBreakGlass = recoverStaffPasswordBreakGlass,
) {
  const parsed = parseBreakGlassCliArgs(argv, env);
  const outcome = await execute({
    ...(parsed.userId ? { userId: parsed.userId } : {}),
    ...(parsed.username ? { username: parsed.username } : {}),
    password: parsed.password,
    reason: parsed.reason,
    operator: parsed.operator,
    operationId: parsed.operationId,
  });
  return {
    ...outcome,
    ...(parsed.generatedPassword ? { temporaryPassword: parsed.password } : {}),
  };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runBreakGlassCli()
    .then((result) => {
      console.log(JSON.stringify({ event: "identity.break_glass_recovery.completed", ...result }, null, 2));
      process.exit(0);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Break-glass recovery failed";
      console.error(JSON.stringify({ event: "identity.break_glass_recovery.failed", error: message }));
      process.exit(1);
    });
}
