import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const transportPath = fileURLToPath(new URL("../src/plugin/codex-desktop-fetch.ts", import.meta.url));

// Keep Pi's request encoding, SSE parsing and tool handling. Only its Codex
// module gets a lexical fetch binding; other Providers and global fetch stay intact.
export const piCodexDesktopTransportPlugin = {
  name: "echoink-codex-desktop-transport",
  setup(build) {
    build.onLoad({ filter: /[\\/]@earendil-works[\\/]pi-ai[\\/]dist[\\/]api[\\/]openai-codex-responses\.js$/ }, async ({ path: sourcePath }) => {
      const source = await fs.readFile(sourcePath, "utf8");
      if (!source.includes("response = await fetch(resolveCodexUrl(model.baseUrl), {")) {
        throw new Error("Pi Codex fetch changed; re-audit the desktop transport bridge.");
      }
      return {
        loader: "js",
        resolveDir: path.dirname(sourcePath),
        contents: `import { codexDesktopFetch as fetch } from ${JSON.stringify(transportPath)};\n${source}`
      };
    });
  }
};
