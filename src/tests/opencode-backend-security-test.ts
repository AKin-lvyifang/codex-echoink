import * as assert from "node:assert/strict";
import { chmod, copyFile, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { OpenCodeBackend } from "../core/opencode-backend";
import { openCodeAuthorizationConnectionOverrides } from "../core/opencode-auth";

const SECURITY_SERVER_START_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
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

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
