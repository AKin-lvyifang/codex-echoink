import * as assert from "node:assert/strict";
import { chmod, copyFile, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { OpenCodeBackend, openCodePermissionRules } from "../core/opencode-backend";
import { openCodeAuthorizationConnectionOverrides } from "../core/opencode-auth";

const SECURITY_SERVER_START_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  testMaintenanceShadowPermissionRules();
  await testProviderQualifiedModelIdsAtSdkBoundary();
  await testCliCompletedEmptyDoesNotRecoverToolPrelude();
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "echoink opencode [owned]-"));
  const fakeCommand = path.join(fixtureDirectory, "fake-opencode.exe");
  const unsafeUrlCommand = path.join(fixtureDirectory, "unsafe-opencode.exe");
  const serveScript = path.join(fixtureDirectory, "serve");
  const fixtureSource = [
    ...(process.platform === "win32" ? [] : ["#!/usr/bin/env node"]),
    "const http = require('node:http');",
    "const executable = `${process.argv0 || ''} ${process.argv[1] || ''}`.toLowerCase();",
    "if (executable.includes('unsafe-opencode')) {",
    "  console.log('opencode server listening on https://example.com:443');",
    "  setInterval(() => undefined, 1000);",
    "} else {",
    "const hostnameArg = process.argv.find((arg) => arg.startsWith('--hostname='));",
    "const portArg = process.argv.find((arg) => arg.startsWith('--port='));",
    "const hostname = hostnameArg?.slice('--hostname='.length) || '127.0.0.1';",
    "const port = Number(portArg?.slice('--port='.length) || '4096');",
    "const server = http.createServer((request, response) => {",
    "  request.resume();",
    "  request.on('end', () => {",
    "    response.writeHead(200, { 'content-type': 'application/json' });",
    "    response.end(request.url?.startsWith('/global/health') ? JSON.stringify({ healthy: true, version: 'fixture-1.0.0' }) : 'true');",
    "  });",
    "});",
    "server.listen(port, hostname, () => {",
    "  const address = server.address();",
    "  console.log(`opencode server listening on http://${hostname}:${address.port}`);",
    "});",
    "const stop = () => server.close(() => process.exit(0));",
    "process.on('SIGTERM', stop);",
    "process.on('SIGINT', stop);",
    "}"
  ].join("\n");
  if (process.platform === "win32") {
    await writeFile(serveScript, fixtureSource, "utf8");
    for (const command of [fakeCommand, unsafeUrlCommand]) {
      try {
        await link(process.execPath, command);
      } catch {
        await copyFile(process.execPath, command);
      }
    }
  } else {
    for (const command of [fakeCommand, unsafeUrlCommand]) {
      await writeFile(command, fixtureSource, "utf8");
      await chmod(command, 0o755);
    }
  }

  let unknownRequestCount = 0;
  const unknownPaths: string[] = [];
  const unknownServer = http.createServer((request, response) => {
    unknownRequestCount += 1;
    unknownPaths.push(request.url ?? "");
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ healthy: true, version: "unknown" }));
  });
  const unknownPort = await new Promise<number>((resolve) => {
    unknownServer.listen(0, "127.0.0.1", () => {
      const address = unknownServer.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });

  const commonOptions = {
    cliPath: fakeCommand,
    autoStart: true,
    hostname: "127.0.0.1",
    port: unknownPort,
    vaultPath: fixtureDirectory,
    providerId: "",
    modelId: "",
    agent: "",
    startTimeoutMs: SECURITY_SERVER_START_TIMEOUT_MS
  };
  const ownedBackend = new OpenCodeBackend({
    ...commonOptions,
    ...openCodeAuthorizationConnectionOverrides()
  });
  const unknownBackend = new OpenCodeBackend({
    ...commonOptions,
    serverUrl: `http://127.0.0.1:${unknownPort}`,
    autoStart: false
  });
  try {
    await ownedBackend.connect();
    const ownedConnection = ownedBackend.getConnectionInfo();
    assert.match(ownedConnection.serverUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(ownedConnection.serverUrl, `http://127.0.0.1:${unknownPort}`);
    assert.equal(unknownRequestCount, 0, "授权 backend 不得探测或复用任意已有本地服务");
    assert.equal(await ownedBackend.setProviderApiKey("fixture", "fixture-secret"), true);
    await ownedBackend.disconnect();

    await unknownBackend.connect();
    await assert.rejects(
      () => unknownBackend.setProviderApiKey("fixture", "must-not-reach-unknown-process"),
      /不属于当前 EchoInk 进程/
    );
    assert.equal(unknownPaths.length, 1, "未知服务只能接收一次连接探测");
    assert.match(unknownPaths[0], /^\/global\/health(?:\?|$)/, "未知服务不能接收凭据请求");

    const unsafeUrlBackend = new OpenCodeBackend({
      ...commonOptions,
      cliPath: unsafeUrlCommand,
      ...openCodeAuthorizationConnectionOverrides()
    });
    await assert.rejects(() => unsafeUrlBackend.connect(), /没有返回安全的本机监听地址/);
    await unsafeUrlBackend.disconnect();
  } finally {
    await Promise.allSettled([ownedBackend.disconnect(), unknownBackend.disconnect()]);
    await new Promise<void>((resolve) => unknownServer.close(() => resolve()));
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

function testMaintenanceShadowPermissionRules(): void {
  const shadowRoot = path.resolve(path.join(tmpdir(), "echoink-shadow-permission"));
  const rules = openCodePermissionRules("workspace-write", [
    path.join(shadowRoot, "wiki"),
    path.join(shadowRoot, "projects"),
    path.join(shadowRoot, "outputs"),
    path.join(shadowRoot, "inbox")
  ], shadowRoot);
  assert.deepEqual(rules[0], { permission: "*", pattern: "*", action: "deny" });
  assert.equal(rules.some((rule) =>
    rule.permission === "edit" && rule.pattern === "wiki/**" && rule.action === "allow"
  ), true);
  assert.equal(rules.some((rule) =>
    rule.permission === "edit" && rule.pattern === "raw/**" && rule.action === "allow"
  ), false);
  const outputsAllow = rules.findIndex((rule) =>
    rule.permission === "edit" && rule.pattern === "outputs/**" && rule.action === "allow"
  );
  const trackerDeny = rules.findIndex((rule) =>
    rule.permission === "edit" && rule.pattern === "outputs/.ingest-tracker.md" && rule.action === "deny"
  );
  assert.equal(outputsAllow >= 0, true);
  assert.equal(trackerDeny > outputsAllow, true);
}

async function testCliCompletedEmptyDoesNotRecoverToolPrelude(): Promise<void> {
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "echoink opencode empty final-"));
  const fakeCommand = path.join(fixtureDirectory, "empty-opencode.exe");
  const runScript = path.join(fixtureDirectory, "run");
  const cliEvents = [
    { type: "step_start", sessionID: "ses_empty_final", part: { messageID: "msg_tool" } },
    { type: "text", sessionID: "ses_empty_final", part: { messageID: "msg_tool", text: "TOOL_PRELUDE" } },
    { type: "step_finish", sessionID: "ses_empty_final", part: { messageID: "msg_tool", reason: "tool-calls" } },
    { type: "step_start", sessionID: "ses_empty_final", part: { messageID: "msg_final" } },
    { type: "step_finish", sessionID: "ses_empty_final", part: { messageID: "msg_final", reason: "stop", tokens: { input: 12, output: 0, total: 12 } } }
  ];
  const fixtureSource = [
    ...(process.platform === "win32" ? [] : ["#!/usr/bin/env node"]),
    `const events = ${JSON.stringify(cliEvents)};`,
    "for (const event of events) console.log(JSON.stringify(event));"
  ].join("\n");
  if (process.platform === "win32") {
    await writeFile(runScript, fixtureSource, "utf8");
    try {
      await link(process.execPath, fakeCommand);
    } catch {
      await copyFile(process.execPath, fakeCommand);
    }
  } else {
    await writeFile(fakeCommand, fixtureSource, "utf8");
    await chmod(fakeCommand, 0o755);
  }

  let messageReadCount = 0;
  const server = http.createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    request.resume();
    if (requestPath === "/global/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ healthy: true, version: "empty-final-fixture" }));
      return;
    }
    if (requestPath === "/session/ses_empty_final/message") {
      messageReadCount += 1;
      const messages = messageReadCount === 1 ? [] : [
        {
          info: { id: "msg_tool", role: "assistant", time: { created: 1, completed: 2 }, finish: "tool-calls" },
          parts: [{ type: "text", text: "TOOL_PRELUDE" }]
        },
        {
          info: { id: "msg_final", role: "assistant", time: { created: 3, completed: 4 }, finish: "stop" },
          parts: []
        }
      ];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(messages));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected fixture request" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const backend = new OpenCodeBackend({
    cliPath: fakeCommand,
    serverUrl: `http://127.0.0.1:${address.port}`,
    autoStart: false,
    hostname: "127.0.0.1",
    port: address.port,
    vaultPath: fixtureDirectory,
    providerId: "",
    modelId: "",
    agent: ""
  });
  try {
    await backend.connect();
    const result = await backend.runCliTask({
      prompt: "return an empty final",
      nativeSessionId: "ses_empty_final"
    });
    assert.equal(result.text, "", "a completed empty final must not revive the earlier tool prelude");
    assert.equal(result.runId, "ses_empty_final");
    assert.equal(messageReadCount, 1, "an authoritative empty CLI final must skip post-run session recovery");
  } finally {
    await backend.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

async function testProviderQualifiedModelIdsAtSdkBoundary(): Promise<void> {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const rawBody = Buffer.concat(chunks).toString("utf8");
      if (rawBody) requests.push({ path: requestPath, body: JSON.parse(rawBody) as Record<string, unknown> });
      if (requestPath === "/global/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ healthy: true, version: "model-shape-fixture" }));
        return;
      }
      if (requestPath === "/session") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "session-model-shape", title: "Model shape" }));
        return;
      }
      if (requestPath === "/session/session-model-shape/message") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ info: { agent: "build" }, parts: [{ type: "text", text: "PONG" }] }));
        return;
      }
      if (requestPath === "/session/session-model-shape/prompt_async") {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected fixture request" }));
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
  const backend = new OpenCodeBackend({
    cliPath: "opencode",
    serverUrl: `http://127.0.0.1:${port}`,
    autoStart: false,
    hostname: "127.0.0.1",
    port,
    vaultPath: "/fixture-vault",
    providerId: "opencode",
    modelId: "opencode/big-pickle",
    agent: "build"
  });
  try {
    await backend.connect();
    const session = await backend.startSession({ title: "Model shape", permission: "read-only" });
    await backend.sendPrompt({
      sessionId: session.sessionId,
      parts: [{ type: "text", text: "sync" }],
      model: { providerId: "opencode", modelId: "opencode/big-pickle" },
      agent: "build"
    });
    await backend.sendPromptAsync({
      sessionId: session.sessionId,
      parts: [{ type: "text", text: "async" }],
      model: { providerId: "opencode", modelId: "opencode/big-pickle" },
      agent: "build"
    });
    assert.deepEqual(requests.map((entry) => entry.path), [
      "/session",
      "/session/session-model-shape/message",
      "/session/session-model-shape/prompt_async"
    ]);
    assert.deepEqual(requests[0]?.body.model, { id: "big-pickle", providerID: "opencode" });
    assert.deepEqual(requests[1]?.body.model, { providerID: "opencode", modelID: "big-pickle" });
    assert.deepEqual(requests[2]?.body.model, { providerID: "opencode", modelID: "big-pickle" });
  } finally {
    await backend.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
