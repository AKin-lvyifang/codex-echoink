import assert from "node:assert/strict";
import { createRequire, isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import esbuild from "esbuild";
import { piOpenAICodexOAuthPlugin } from "./pi-codex-oauth-compat.mjs";

// Use the production OAuth bundle rewrite and real Pi auth resolver. All
// responses and credentials are synthetic; no browser or network is opened.
const root = fileURLToPath(new URL("../", import.meta.url));
const build = await esbuild.build({
  stdin: {
    contents: `export { OpenAICodexOAuthService } from "./src/plugin/openai-codex-oauth-service";`,
    resolveDir: root,
    loader: "ts"
  },
  bundle: true,
  write: false,
  platform: "node",
  target: "node20",
  format: "cjs",
  plugins: [piOpenAICodexOAuthPlugin],
  logLevel: "silent"
});
const localRequire = createRequire(import.meta.url);
let fetchImpl = () => { throw new Error("Unexpected network request"); };
const module = { exports: {} };
const context = vm.createContext({
  module, exports: module.exports,
  require(name) {
    assert.ok(isBuiltin(name), `unexpected external dependency: ${name}`);
    return localRequire(name);
  },
  process, Buffer, Headers, Response, Request, ReadableStream, URL, URLSearchParams,
  AbortController, AbortSignal, DOMException, Error, TypeError, RangeError,
  TextEncoder, TextDecoder, atob, btoa, crypto: webcrypto, structuredClone,
  fetch: (...args) => fetchImpl(...args),
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, console
});
vm.runInContext(build.outputFiles[0].text, context, { filename: "codex-oauth-compat-fixture.cjs" });
const { OpenAICodexOAuthService } = module.exports;

function token(extra = {}) {
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" }, ...extra };
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`;
}
function tokenResponse(access = token()) {
  return new Response(JSON.stringify({
    access_token: access, refresh_token: "fixture-rotated-refresh", expires_in: 3600
  }), { status: 200 });
}
function fixture(credential = { type: "oauth", access: "fixture-old", refresh: "fixture-refresh", expires: 1 }) {
  let saves = 0;
  const host = { settings: { openAICodexCredential: credential }, saveSettings: async () => { saves++; } };
  return { host, service: new OpenAICodexOAuthService(host), saves: () => saves };
}
async function expectCode(action, code) {
  await assert.rejects(action, error => {
    assert.equal(error.code, code);
    assert.ok(!`${error.message} ${JSON.stringify(error)}`.includes("fixture-secret"));
    assert.equal(error.cause, undefined, "the public error must not expose Pi's raw response or credentials");
    return true;
  });
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`OK ${name}`); }

await test("OAuth refresh decodes valid Base64URL JWTs with ASCII and Unicode claims", async () => {
  // These account-independent claims produce both '-' and '_' in the JWT.
  for (const extra of [{}, { name: "~" }, { name: "?" }, { name: "中文 😀 ~?" }]) {
    const access = token(extra);
    fetchImpl = async () => tokenResponse(access);
    const { service, host, saves } = fixture();
    assert.equal(await service.resolveAccessToken(), access);
    assert.equal(host.settings.openAICodexCredential.accountId, "fixture-account");
    assert.equal(host.settings.openAICodexCredential.refresh, "fixture-rotated-refresh");
    assert.equal((await service.status()).state, "connected");
    assert.equal(saves(), 1);
  }
});

await test("revoked authorization is distinct from temporary network, HTTP and format failures", async () => {
  const cases = [
    [400, { error: "invalid_grant", error_description: "fixture-secret" }, "provider_oauth_relogin_required"],
    [400, { error: { code: "refresh_token_reused", message: "fixture-secret" } }, "provider_oauth_relogin_required"],
    [401, "fixture-secret", "provider_oauth_relogin_required"],
    [403, "fixture-secret", "provider_oauth_relogin_required"],
    [429, "fixture-secret", "provider_rate_limited"],
    [503, "fixture-secret", "provider_service_unavailable"],
    [400, { error: "invalid_request", message: "fixture-secret" }, "provider_request_rejected"],
    [422, { error: "invalid_request", message: "fixture-secret" }, "provider_request_rejected"],
    [404, "fixture-secret", "provider_protocol_failed"],
    [409, "fixture-secret", "provider_unavailable"],
    [200, { access_token: "fixture-secret" }, "provider_protocol_failed"],
    [200, "fixture-secret", "provider_protocol_failed"]
  ];
  for (const [status, body, code] of cases) {
    fetchImpl = async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    const { service, host, saves } = fixture();
    await expectCode(() => service.resolveAccessToken(), code);
    assert.equal((await service.status()).state, "expired");
    assert.equal(host.settings.openAICodexCredential.refresh, "fixture-refresh");
    assert.equal(saves(), 0, "failed refresh must not mutate or delete the stored credential");
  }
  fetchImpl = async () => { throw new TypeError("Network failure fixture-secret"); };
  await expectCode(() => fixture().service.resolveAccessToken(), "provider_network_error");
});

await test("invalid JWT content is a format failure rather than a revoked authorization", async () => {
  for (const access of ["not-a-jwt-fixture-secret", "header.%%%%.signature", `header.${Buffer.from('{}').toString('base64url')}.signature`]) {
    fetchImpl = async () => tokenResponse(access);
    await expectCode(() => fixture().service.resolveAccessToken(), "provider_protocol_failed");
  }
  await expectCode(() => fixture(null).service.resolveAccessToken(), "provider_oauth_relogin_required");
});

await test("temporary failure can recover with the same stored refresh credential", async () => {
  const { service } = fixture();
  fetchImpl = async () => new Response("Service unavailable", { status: 503 });
  await expectCode(() => service.resolveAccessToken(), "provider_service_unavailable");
  fetchImpl = async () => tokenResponse();
  assert.equal(await service.resolveAccessToken(), token());
  assert.equal((await service.status()).state, "connected");
});

await test("concurrent expired requests still refresh once and logout still deletes the credential", async () => {
  const { service, saves } = fixture();
  let calls = 0;
  fetchImpl = async () => { calls++; return tokenResponse(); };
  await Promise.all([service.resolveAccessToken(), service.resolveAccessToken()]);
  assert.equal(calls, 1);
  assert.equal(saves(), 1);
  await service.logout();
  assert.equal(saves(), 2);
  assert.equal((await service.status()).state, "disconnected");
});

console.log(`Codex OAuth compatibility tests passed: ${passed}`);
