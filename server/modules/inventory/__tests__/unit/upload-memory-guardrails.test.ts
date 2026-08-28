import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { UPLOAD_MAX_BYTES } from "../../../../routes/middleware";

const REPO = resolve(__dirname, "../../../../..");

/**
 * Guardrails for the two ways this dyno can be killed by memory it never
 * intended to hold.
 *
 * 1. `multer.memoryStorage()` without `limits` buffers an entire upload in RAM
 *    with no ceiling. The shared `upload` in server/routes/middleware.ts backs
 *    at least six routes, including /api/vendor-invoices/:id/attachments.
 *
 * 2. Buffers live OFF-heap, so `--max-old-space-size` does not constrain them -
 *    which is exactly why both guards are needed rather than either alone.
 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      sourceFiles(full, acc);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("in-memory upload limits", () => {
  it("every multer instance declares a fileSize limit", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(REPO, "server"))) {
      const src = readFileSync(file, "utf8");
      for (const block of src.match(/multer(?:\.default)?\(\{[\s\S]{0,300}?\}\)/g) ?? []) {
        if (!/limits/.test(block)) {
          offenders.push(`${file.slice(REPO.length + 1)}: ${block.slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has a sane shared ceiling", () => {
    expect(UPLOAD_MAX_BYTES).toBeGreaterThan(0);
    expect(UPLOAD_MAX_BYTES).toBeLessThanOrEqual(25 * 1024 * 1024);
  });
});

describe("V8 heap ceiling", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

  it("tells V8 the dyno's limit instead of letting it read the host's RAM", () => {
    // Without this, V8 sizes its heap from the host's memory (many GB on Heroku),
    // stays lazy about collecting, and is killed at the 512MB dyno quota while
    // still holding garbage it would have freed.
    expect(pkg.scripts.start).toMatch(/--max-old-space-size=\d+/);
  });

  it("leaves headroom for everything that lives outside the heap", () => {
    const cap = Number(/--max-old-space-size=(\d+)/.exec(pkg.scripts.start)?.[1]);
    // Buffers, native memory and the runtime itself also count toward the 512MB
    // quota, so the heap alone must not be allowed to consume it.
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(512);
  });
});
