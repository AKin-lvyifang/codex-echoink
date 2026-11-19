/** Real plugin account/transport + committed web server over loopback HTTP.
 * ECHOINK_WEB_ROOT=/path/to/echoink-web node scripts/verify-report-login-joint.mjs
 * Add --keep-server for disposable native acceptance; Ctrl-C cleans its snapshot/data.
 * Only the Obsidian requestUrl host API is adapted to Node fetch; no response is mocked.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import esbuild from "esbuild";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const webRoot = process.env.ECHOINK_WEB_ROOT;
if (!webRoot || !path.isAbsolute(webRoot)) throw new Error("Set ECHOINK_WEB_ROOT to a read-only web checkout");
const evidence = path.resolve(process.env.ECHOINK_JOINT_EVIDENCE || "docs/claude建议/推进记录/证据/2026-11-16-上报需登录");
if (!process.env.ECHOINK_JOINT_SNAPSHOT) {
  const revision = execFileSync("git", ["-C", webRoot, "rev-parse", process.env.ECHOINK_WEB_REV || "main"], { encoding: "utf8" }).trim();
  const snapshot = await mkdtemp(path.join(tmpdir(), "echoink-report-joint-"));
  try {
    const archive = execFileSync("git", ["-C", webRoot, "archive", revision, "src", "shared", "assets", "server-content", "public/expert-avatars", "public/release-media.js", "package.json", "tsconfig.json"], { maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", snapshot], { input: archive });
    await symlink(path.join(webRoot, "node_modules"), path.join(snapshot, "node_modules"), "dir");
    const require = createRequire(path.join(webRoot, "package.json"));
    const child = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx/esm")).href, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      cwd: snapshot, stdio: "inherit", env: { ...process.env, NODE_ENV: "test", MAIL_MODE: "capture", ECHOINK_JOINT_SNAPSHOT: snapshot,
        ECHOINK_JOINT_REVISION: revision, ECHOINK_JOINT_EVIDENCE: evidence }
    });
    const stop = () => child.kill("SIGTERM"); process.on("SIGINT", stop); process.on("SIGTERM", stop);
    const code = await new Promise(resolve => child.on("exit", code => resolve(code ?? 1)));
    process.off("SIGINT", stop); process.off("SIGTERM", stop); process.exitCode = code;
  } finally { await rm(snapshot, { recursive: true, force: true }); }
} else {
  const snapshot = process.env.ECHOINK_JOINT_SNAPSHOT;
  const { createApp } = await import(pathToFileURL(path.join(snapshot, "src/app.ts")).href);
  const require = createRequire(path.join(snapshot, "package.json"));
  const { serve } = require("@hono/node-server");
  const dataDir = path.join(snapshot, "isolated-data"); await mkdir(dataDir);
  const config = { dataDir, baseURL: "http://127.0.0.1", origins: ["app://obsidian.md"], production: false, mailMode: "capture",
    secret: randomBytes(48).toString("base64url"), signingKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    signingKeyId: "joint-test", adminEmails: [], seats: 3, leaseDays: 7, earlyStock: 200, checkout: {} };
  const runtime = await createApp(config);
  const wire = [];
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const url = new URL(request.url);
    // Harness-only access to captured mail, never added to web source or production.
    if (url.pathname === "/__acceptance/otp") return Response.json({ code: runtime.authentication.captured.get(`${url.searchParams.get("email")}:login`) ?? null });
    if (url.pathname === "/__acceptance/reports") return Response.json(runtime.db.prepare("SELECT id,user_id,plugin_version FROM run_reports").all());
    const response = await runtime.app.fetch(request, { ip: "127.0.0.1" });
    const error = response.status >= 400 ? (await response.clone().json()).error : undefined;
    wire.push({ method: request.method, path: url.pathname, status: response.status, ...(error ? { error } : {}) });
    return response;
  } });
  await new Promise(resolve => server.listening ? resolve() : server.once("listening", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`; config.baseURL = baseURL; config.origins.push(baseURL);
  const hostFile = path.join(snapshot, "obsidian-http-host.mjs");
  await writeFile(hostFile, `export async function requestUrl(input) {
    const response = await fetch(input.url, { method: input.method, headers: input.headers, body: input.body });
    const arrayBuffer = await response.arrayBuffer(), text = new TextDecoder().decode(arrayBuffer);
    return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer, text, json: JSON.parse(text) };
  }`);
  const clientFile = path.join(snapshot, "plugin-client.mjs");
  await esbuild.build({ stdin: { contents: [
    'export {AccountService} from "./src/membership/account-service";',
    'export {createMembershipTransport} from "./src/membership/transport";',
    'export {createMobileMembershipStorage} from "./src/membership/mobile-storage";',
    'export {uploadRunReport} from "./src/run-reports/upload";',
    'export {RunReportAuthError} from "./src/run-reports/login";',
    'export {freezeReport,reportWithoutConversation,describeSnapshot} from "./src/run-reports/report";'
  ].join("\n"), resolveDir: pluginRoot, loader: "ts" }, outfile: clientFile, bundle: true, platform: "node", format: "esm", alias: { obsidian: hostFile }, loader: { ".md": "text" }, logLevel: "silent" });
  globalThis.window = globalThis;
  const client = await import(pathToFileURL(clientFile).href);
  const transport = client.createMembershipTransport(baseURL);
  const storage = await client.createMobileMembershipStorage(undefined, baseURL);
  const account = new client.AccountService(storage, transport, baseURL, () => {}, baseURL, () => "missing");
  try {
    await account.initialize();
    const report = client.describeSnapshot(client.freezeReport(client.reportWithoutConversation({ pluginVersion: "2.9.0", obsidianVersion: "joint-test", platform: "macos", surface: "desktop", language: "zh", membership: "free" }, [])), "本地真实接口联合验收报告", "");
    let before = wire.length;
    await assert.rejects(client.uploadRunReport(report, account), error => error instanceof client.RunReportAuthError);
    assert.equal(wire.length, before);
    const email = "report-joint@example.test";
    await account.actions.requestCode({ email, purpose: "login" });
    const credential = runtime.authentication.captured.get(`${email}:login`); assert.ok(credential);
    await account.actions.signIn({ email, method: "code", credential });
    assert.equal(account.read().identity.email, email);
    const who = await transport("/api/account", "GET", undefined, account.apiToken());
    const id = await client.uploadRunReport(report, account);
    const stored = runtime.db.prepare("SELECT id,user_id,plugin_version FROM run_reports WHERE id=?").get(id);
    assert.equal(stored.user_id, who.id); assert.equal(stored.plugin_version, "2.9.0");
    const feedback = await transport("/api/account/run-reports", "GET", undefined, account.apiToken());
    assert.ok(feedback.items.some(item => item.id === id));
    const count = runtime.db.prepare("SELECT COUNT(*) n FROM run_reports").get().n;
    runtime.db.prepare("UPDATE session SET expiresAt=? WHERE userId=?").run(Date.now() - 1000, who.id);
    before = wire.length;
    await assert.rejects(client.uploadRunReport(report, account), error => error instanceof client.RunReportAuthError && error.code === "AUTH_REQUIRED");
    assert.equal(wire[before].status, 401); assert.equal(wire[before].error, "AUTH_REQUIRED"); assert.equal(account.read().identity, null);
    assert.equal(runtime.db.prepare("SELECT COUNT(*) n FROM run_reports").get().n, count);
    before = wire.length;
    await assert.rejects(client.uploadRunReport(report, account), error => error instanceof client.RunReportAuthError);
    await assert.rejects(client.uploadRunReport(report), error => error instanceof client.RunReportAuthError);
    assert.equal(wire.length, before);
    const result = { passed: true, serverRevision: process.env.ECHOINK_JOINT_REVISION, pluginRevision: execFileSync("git", ["-C", pluginRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      baseURL, mailMode: "capture", isolatedDatabase: true, actualHttp: true, productionRequests: 0,
      report: stored, expectedUserId: who.id, feedbackVisible: true, expiredStatus: 401, expiredError: "AUTH_REQUIRED", pluginError: "RunReportAuthError", signedOutAfterExpiry: true,
      reportsAfterExpiry: count, unsignedNetworkRequests: 0, requests: wire };
    await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, "07-真实接口联合验收.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ passed: true, reportId: id, accountBound: true, feedbackVisible: true, expiredRejected: true, unsignedNetworkRequests: 0, baseURL }));
    if (process.argv.includes("--keep-server")) {
      await mkdir(path.join(pluginRoot, ".tmp"), { recursive: true });
      await writeFile(path.join(pluginRoot, ".tmp/report-joint-server.json"), JSON.stringify({ baseURL, pid: process.pid, snapshot }));
      console.log("Loopback server ready for disposable native acceptance; captured mail stays in memory.");
      await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
    }
  } finally {
    account.dispose(); await new Promise(resolve => server.close(resolve));
    await Promise.all([runtime.checkout.stop(), runtime.pluginDownloads.stop(), runtime.weather.stop(), runtime.runReports.stop(), runtime.behaviorAI.stop(), runtime.behavior.stop(), runtime.transactionalMail.stop()]);
    runtime.db.close();
  }
}
