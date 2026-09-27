import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const protocolPath = fileURLToPath(new URL("../src/plugin/codex-protocol-compat.ts", import.meta.url));
const errorsPath = fileURLToPath(new URL("../src/plugin/codex-oauth-errors.ts", import.meta.url));

function replaceRequired(source, original, replacement) {
  if (!source.includes(original)) {
    throw new Error("Pi OpenAI Codex OAuth contract changed; re-audit the compatibility bridge.");
  }
  return source.replace(original, replacement);
}

/**
 * EchoInk exposes only Pi 0.82.1's OpenAI Codex OAuth flow. Pi deliberately
 * hides OAuth implementations behind a variable dynamic import for browser
 * builds, but an Obsidian single-file plugin has no package-relative module at
 * runtime. Rewrite only the OpenAI Codex loader to a static import and bridge
 * its Node builtins through the CommonJS path supported by Obsidian Node 20.
 */
export const piOpenAICodexOAuthPlugin = {
  name: "echoink-pi-openai-codex-oauth",
  setup(build) {
    build.onLoad(
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-ai[\\/]dist[\\/]auth[\\/]oauth[\\/]load\.js$/
      },
      async (args) => {
        const source = await fs.promises.readFile(args.path, "utf8");
        const original = `export const loadOpenAICodexOAuth = async () => {
    if (bundledLoaders)
        return bundledLoaders.openaiCodex();
    return (await importOAuthModule("./openai-codex.ts")).openaiCodexOAuth;
};`;
        if (!source.includes(original)) {
          throw new Error(
            "Pi OpenAI Codex OAuth loader changed; re-audit the static bundle bridge."
          );
        }
        const rewritten = `import { openaiCodexOAuth as echoInkOpenAICodexOAuth } from "./openai-codex.js";\n`
          + source.replace(original, `export const loadOpenAICodexOAuth = async () => {
    if (bundledLoaders)
        return bundledLoaders.openaiCodex();
    return echoInkOpenAICodexOAuth;
};`);
        return {
          loader: "js",
          resolveDir: path.dirname(args.path),
          contents: rewritten
        };
      }
    );

    build.onLoad(
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-ai[\\/]dist[\\/]auth[\\/]oauth[\\/]openai-codex\.js$/
      },
      async (args) => {
        const source = await fs.promises.readFile(args.path, "utf8");
        const original = `if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
    import("node:crypto").then((m) => {
        _randomBytes = m.randomBytes;
    });
    import("node:http").then((m) => {
        _http = m;
    });
}`;
        if (!source.includes(original)) {
          throw new Error(
            "Pi OpenAI Codex OAuth Node bridge changed; re-audit Obsidian compatibility."
          );
        }
        let rewritten = source.replace(original, `if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
    _randomBytes = require("node:crypto").randomBytes;
    _http = require("node:http");
}`);
        rewritten = replaceRequired(rewritten,
          "const decoded = atob(payload);",
          "const decoded = decodeCodexJwtBase64Url(payload);");
        const tokenResponse = rewritten.match(/async function readTokenResponse\(response, operation\) \{[\s\S]*?\n\}/)?.[0];
        if (!tokenResponse) {
          throw new Error("Pi OpenAI Codex token response reader changed; re-audit the compatibility bridge.");
        }
        rewritten = replaceRequired(rewritten, tokenResponse, `async function readTokenResponse(response) {
    return readOpenAICodexTokenResponse(response);
}`);
        rewritten = replaceRequired(rewritten,
          "response = await fetch(TOKEN_URL, {",
          "response = await fetchOpenAICodexOAuthToken(fetch, TOKEN_URL, {");
        rewritten = replaceRequired(rewritten,
          'throw new Error(`OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`);',
          "throw error;");
        rewritten = replaceRequired(rewritten,
          'throw new Error("Failed to extract accountId from token");',
          'throw new OpenAICodexAuthError("provider_protocol_failed");');
        rewritten = `import { decodeCodexJwtBase64Url } from ${JSON.stringify(protocolPath)};\n`
          + `import { OpenAICodexAuthError, fetchOpenAICodexOAuthToken, readOpenAICodexTokenResponse } from ${JSON.stringify(errorsPath)};\n`
          + rewritten;
        return {
          loader: "js",
          resolveDir: path.dirname(args.path),
          contents: rewritten
        };
      }
    );
  }
};
