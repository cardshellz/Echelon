import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  it("runs the same bounded Node command for Heroku and npm", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    const web = readFileSync(join(REPO, "Procfile"), "utf8")
      .split(/\r?\n/).find(line => line.startsWith("web:"));
    expect(web).toBe(`web: ${pkg.scripts.start}`);
    expect(pkg.scripts.start).toBe("bash scripts/start-web.sh");

    // Run the production launcher with a tiny stand-in entry point so the test
    // observes Node's effective limits, environment, and process handoff.
    const tempRoot = realpathSync(tmpdir());
    const directory = mkdtempSync(join(tempRoot, "echelon-web-launch-"));
    if (dirname(realpathSync(directory)) !== tempRoot) throw new Error("Unexpected test directory");
    try {
      mkdirSync(join(directory, "dist"));
      writeFileSync(join(directory, "dist", "index.cjs"), [
        "const v8 = require('node:v8');",
        "console.log(JSON.stringify({ pid: process.pid, nodeEnv: process.env.NODE_ENV,",
        "  args: process.execArgv, heapLimit: v8.getHeapStatistics().heap_size_limit }));",
      ].join("\n"));
      const windowsBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
      const bash = process.platform === "win32" && existsSync(windowsBash) ? windowsBash : "bash";
      const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
      delete environment.NODE_OPTIONS;
      const result = spawnSync(bash, [join(REPO, "scripts", "start-web.sh")], {
        cwd: directory, env: environment, encoding: "utf8", timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const runtime = JSON.parse(result.stdout) as {
        pid: number; nodeEnv: string; args: string[]; heapLimit: number;
      };
      expect(runtime.nodeEnv).toBe("production");
      expect(runtime.args).toContain("--max-old-space-size=384");
      expect(runtime.args).toContain("--max-semi-space-size=16");
      // Assert V8's *total* limit, which includes the young generation. The old
      // test only checked old space and missed the actual 576 MiB total limit.
      expect(runtime.heapLimit).toBeGreaterThan(384 * 1024 * 1024);
      expect(runtime.heapLimit).toBeLessThanOrEqual(448 * 1024 * 1024);
      if (process.platform !== "win32") expect(runtime.pid).toBe(result.pid);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
