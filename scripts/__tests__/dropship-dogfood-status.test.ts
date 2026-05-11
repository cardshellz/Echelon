import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const scriptPath = path.join(repoRoot, "scripts", "dropship-dogfood-status.ts");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, [tsxCli, scriptPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
      },
      timeout: 30_000,
    });

    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (isExecFileError(error)) {
      return {
        code: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      };
    }

    throw error;
  }
}

function isExecFileError(error: unknown): error is Error & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
} {
  return error instanceof Error;
}

describe("dropship dogfood status CLI", () => {
  it("prints help without requiring database configuration", async () => {
    const result = await runCli(["--help"], { DATABASE_URL: "" });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Dropship dogfood launch status");
    expect(result.stdout).toContain("--platform ebay|shopify");
    expect(result.stderr).toBe("");
  });

  it("rejects invalid platform values before database access", async () => {
    const result = await runCli(["--platform", "walmart"], { DATABASE_URL: "" });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--platform must be ebay or shopify.");
  });

  it("fails clearly when runtime database configuration is missing", async () => {
    const result = await runCli([], { DATABASE_URL: "" });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("DATABASE_URL is required to load dropship dogfood launch status.");
  });
});
