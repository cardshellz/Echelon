import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

const routes = source(
  "server",
  "platform",
  "commands",
  "financial-command-operations.routes.ts",
);
const service = source(
  "server",
  "platform",
  "commands",
  "financial-command-operations.service.ts",
);

describe("financial command operations HTTP ownership", () => {
  it("separates monitoring, technical detail, and recovery permissions", () => {
    expect(routes).toMatch(
      /\/api\/operations\/financial-commands"[\s\S]{0,120}requirePermission\("operations", "view"\)/,
    );
    expect(routes).toMatch(
      /\/api\/operations\/financial-commands\/:id"[\s\S]{0,120}requirePermission\("operations", "view_technical"\)/,
    );
    expect(routes).toMatch(
      /\/api\/operations\/financial-commands\/:id\/rearm"[\s\S]{0,120}requirePermission\("operations", "triage"\)/,
    );
  });

  it("requires a meaningful bounded recovery reason and records the authenticated operator", () => {
    expect(routes).toContain("z.string().trim().min(10).max(1000)");
    expect(routes).toContain("req.session.user?.id");
    expect(service).toContain("operator_id");
    expect(service).toContain("reason");
  });

  it("does not expose request hashes, idempotency keys, or response bodies in operator reads", () => {
    const readQueries = service.slice(
      service.indexOf("export async function getFinancialCommandOperations"),
      service.indexOf("export async function rearmDeadFinancialCommand"),
    );
    expect(readQueries).not.toContain('AS "idempotencyKey"');
    expect(readQueries).not.toContain('AS "requestHash"');
    expect(readQueries).not.toContain('AS "responseBody"');
  });
});
