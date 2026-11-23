// runner.ts — FALLBACK trial runner (replace with the kit's runner.ts the
// moment the kit downloads; the kit's copy is authoritative).
//
// When MAKEFUN_ENV_URL is set, main.ts hands over here. The runner fetches
// the trial's checks (GET $MAKEFUN_ENV_URL/checks), runs `node main.ts` on
// each one in a fresh directory holding exactly the check's files, with the
// check's standard input and without MAKEFUN_ENV_URL, and posts what it did
// (POST $MAKEFUN_ENV_URL/results): the exit code, stdout, and every regular
// file in the directory afterwards. A check still running after 10 seconds
// is stopped and reported as exit 124.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CHECK_TIMEOUT_MS = 10_000;

function envUrl() {
  const u = process.env.MAKEFUN_ENV_URL;
  if (!u) throw new Error("MAKEFUN_ENV_URL is not set");
  return u.replace(/\/+$/, "");
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} failed: ${res.status}`);
}

function checkFields(check) {
  const id = check.id ?? check.check_id ?? check.name ?? check.slug;
  const args = check.args ?? check.argv ?? check.arguments ?? [];
  const stdin = check.stdin ?? check.input ?? null;
  const files = check.files ?? {};
  return { id, args, stdin, files };
}

function writeFiles(dir, files) {
  const list = Array.isArray(files)
    ? files.map((f) => [f.path ?? f.name, f.content ?? f.text ?? ""])
    : Object.entries(files);
  for (const [path, content] of list) {
    const abs = resolve(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  }
}

function readFiles(dir) {
  const out = {};
  const walk = (d, prefix) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out[rel] = readFileSync(abs, "utf8");
    }
  };
  walk(dir, "");
  return out;
}

export async function runRunner() {
  const base = envUrl();
  const data = await getJson(`${base}/checks`);
  const checks = Array.isArray(data) ? data : data.checks ?? data.trials ?? [];
  const mainPath = resolve(dirname(new URL(import.meta.url).pathname), "main.ts");
  for (const raw of checks) {
    const { id, args, stdin, files } = checkFields(raw);
    const dir = mkdtempSync(join(tmpdir(), "mend-check-"));
    try {
      writeFiles(dir, files);
      const childEnv = { ...process.env };
      delete childEnv.MAKEFUN_ENV_URL;
      const child = spawnSync(process.execPath, [mainPath, ...args], {
        cwd: dir,
        input: stdin ?? undefined,
        env: childEnv,
        timeout: CHECK_TIMEOUT_MS,
        killSignal: "SIGKILL",
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      let exitCode = child.status;
      if (child.error && child.error.code === "ETIMEDOUT") exitCode = 124;
      if (exitCode === null || exitCode === undefined) exitCode = 124;
      const result = {
        id,
        exitCode,
        stdout: child.stdout ?? "",
        files: readFiles(dir),
      };
      await postJson(`${base}/results`, result);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return 0;
}
