import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const transportPath = fileURLToPath(new URL("../src/plugin/codex-desktop-fetch.ts", import.meta.url));
const compatPath = fileURLToPath(new URL("../src/plugin/codex-protocol-compat.ts", import.meta.url));

// Keep Pi's request/event codec and tool handling. Codex alone gets native fetch,
// standard SSE line endings and JWT Base64URL decoding; other Providers stay intact.
export const piCodexDesktopTransportPlugin = {
  name: "echoink-codex-desktop-transport",
  setup(build) {
    build.onLoad({ filter: /[\\/]@earendil-works[\\/]pi-ai[\\/]dist[\\/]api[\\/]openai-codex-responses\.js$/ }, async ({ path: sourcePath }) => {
      let source = await fs.readFile(sourcePath, "utf8");
      if (!source.includes("response = await fetch(resolveCodexUrl(model.baseUrl), {")) {
        throw new Error("Pi Codex fetch changed; re-audit the desktop transport bridge.");
      }
      for (const [before, after] of [
        ["const decoder = new TextDecoder();", "const decoder = new TextDecoder();\n    const normalizeSseNewlines = createCodexSseNewlineNormalizer();"],
        ["buffer += decoder.decode(value, { stream: true });", "buffer += normalizeSseNewlines(decoder.decode(value, { stream: true }));"],
        ["JSON.parse(atob(parts[1]))", "JSON.parse(decodeCodexJwtBase64Url(parts[1]))"]
      ]) {
        if (source.split(before).length !== 2) {
          throw new Error("Pi Codex protocol changed; re-audit the SSE/JWT compatibility bridge.");
        }
        source = source.replace(before, after);
      }
      return {
        loader: "js",
        resolveDir: path.dirname(sourcePath),
        contents: `import { codexDesktopFetch as fetch } from ${JSON.stringify(transportPath)};\nimport { createCodexSseNewlineNormalizer, decodeCodexJwtBase64Url } from ${JSON.stringify(compatPath)};\n${source}`
      };
    });
  }
};
