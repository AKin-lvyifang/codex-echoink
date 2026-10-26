import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const transportPath = fileURLToPath(new URL("../src/plugin/desktop-provider-fetch.ts", import.meta.url));

// Only the three desktop default SDK codecs are rewritten. Dedicated Codex,
// Token Plan, loopback adapters and the independently built mobile bundle stay intact.
export const piDesktopProviderTransportPlugin = {
  name: "echoink-desktop-provider-transport",
  setup(build) {
    build.onLoad({ filter: /[\\/]@earendil-works[\\/]pi-ai[\\/]dist[\\/]api[\\/](?:openai-completions|openai-responses|anthropic-messages)\.js$/ }, async ({ path: sourcePath }) => {
      let source = await fs.readFile(sourcePath, "utf8");
      const anthropic = sourcePath.endsWith("anthropic-messages.js");
      const replacements = anthropic ? [
        ["copilotDynamicHeaders, cacheSessionId);", "copilotDynamicHeaders, cacheSessionId, options?.timeoutMs);"],
        ["optionsHeaders, dynamicHeaders, sessionId) {", "optionsHeaders, dynamicHeaders, sessionId, timeoutMs) {"],
        ["output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);", "output.errorMessage = desktopProviderFailureCode(error) ?? (error instanceof Error ? error.message : JSON.stringify(error));"]
      ] : [
        [sourcePath.endsWith("openai-completions.js") ? "cacheSessionId, compat);" : "options?.headers, cacheSessionId);",
          sourcePath.endsWith("openai-completions.js") ? "cacheSessionId, compat, options?.timeoutMs);" : "options?.headers, cacheSessionId, options?.timeoutMs);"],
        [sourcePath.endsWith("openai-completions.js") ? "compat = getCompat(model)) {" : "optionsHeaders, sessionId) {",
          sourcePath.endsWith("openai-completions.js") ? "compat = getCompat(model), timeoutMs) {" : "optionsHeaders, sessionId, timeoutMs) {"],
        [sourcePath.endsWith("openai-completions.js") ? "output.errorMessage = formatProviderError(normalizeProviderError(error));" : "output.errorMessage = formatOpenAIResponsesError(error);",
          sourcePath.endsWith("openai-completions.js") ? "output.errorMessage = desktopProviderFailureCode(error) ?? formatProviderError(normalizeProviderError(error));" : "output.errorMessage = desktopProviderFailureCode(error) ?? formatOpenAIResponsesError(error);"]
      ];
      for (const [before, after] of replacements) {
        if (source.split(before).length !== 2) throw new Error(`Pi Provider SDK changed; re-audit desktop transport: ${path.basename(sourcePath)}`);
        source = source.replace(before, after);
      }
      const marker = "dangerouslyAllowBrowser: true,";
      if (source.split(marker).length !== (anthropic ? 4 : 2)) throw new Error("Pi SDK client construction changed; re-audit native fetch injection.");
      source = source.replaceAll(marker, `${marker}\n            fetch: createDesktopProviderFetch(undefined, { timeoutMs }),`);
      return {
        loader: "js", resolveDir: path.dirname(sourcePath),
        contents: `import { createDesktopProviderFetch, desktopProviderFailureCode } from ${JSON.stringify(transportPath)};\n${source}`
      };
    });
  }
};
