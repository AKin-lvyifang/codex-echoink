import esbuild from "esbuild";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import process from "process";
import { reactDomScriptResourcesPlugin } from "./scripts/react-dom-script-resources.mjs";
import { piBraceExpansionPlugin } from "./scripts/pi-brace-expansion.mjs";

const buildMode = process.argv[2];
const isPiImageBundleProbe = buildMode === "pi-image-bundle-probe";
const isProd = buildMode === "production" || isPiImageBundleProbe;
const isWatch = buildMode === "watch";

const PI_HTTP_DISPATCHER_MODULE =
  "/node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js";
const PI_DEFAULT_HTTP_TRANSPORT_DISABLED =
  "EchoInk disables Pi default undici transport; controlled provider egress is required.";

/**
 * Pi 0.82.1's SDK entry imports undici@8.5.0 through SettingsManager even when
 * its CLI HTTP dispatcher is never configured. Obsidian 1.13.4 embeds Node
 * 20.14, while that undici build requires Node >=22.19 and throws during
 * module evaluation. EchoInk never uses Pi's default dispatcher: Provider
 * traffic is admitted and streamed by the controlled EchoInk transport.
 *
 * Replace only that exact dormant Pi import with a fail-closed module. If a
 * future code path tries to enable Pi's default HTTP transport, it throws
 * instead of escaping the EchoInk Egress boundary.
 */
const piControlledEgressPlugin = {
  name: "echoink-pi-controlled-egress",
  setup(build) {
    build.onResolve({ filter: /^undici$/ }, (args) => {
      const importer = args.importer.replaceAll("\\", "/");
      if (!importer.endsWith(PI_HTTP_DISPATCHER_MODULE)) return undefined;
      return {
        path: "pi-default-http-transport-disabled",
        namespace: "echoink-pi-controlled-egress",
        sideEffects: false
      };
    });
    build.onLoad(
      {
        filter: /.*/,
        namespace: "echoink-pi-controlled-egress"
      },
      () => ({
        loader: "js",
        contents: `
const fail = () => {
  throw new Error(${JSON.stringify(PI_DEFAULT_HTTP_TRANSPORT_DISABLED)});
};
export class Client { constructor() { fail(); } }
export class Pool { constructor() { fail(); } }
export class EnvHttpProxyAgent { constructor() { fail(); } }
export const setGlobalDispatcher = fail;
export const getGlobalDispatcher = fail;
export const install = fail;
`
      })
    );
  }
};

/**
 * pi-ai checks credential files for its bundled Providers through two dynamic
 * `import("node:...")` helpers. Obsidian's renderer supports Node builtins
 * through the plugin CommonJS `require`, but rejects that dynamic ESM request
 * from its `app://` origin before pi-ai can handle a missing credential. Keep
 * the upstream helpers' asynchronous contracts while routing only their Node
 * builtin lookups through the supported Obsidian bridge.
 */
const piRendererNodeImportShimPlugin = {
  name: "echoink-pi-renderer-node-import-shim",
  setup(build) {
    build.onLoad(
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-ai[\\/]dist[\\/](?:auth[\\/]context|env-api-keys)\.js$/
      },
      async (args) => {
        const source = await fs.promises.readFile(args.path, "utf8");
        const rewrittenAuthContext = source.replace(
          "importNodeModule = (specifier) => import(__rewriteRelativeImportExtension(specifier));",
          "importNodeModule = (specifier) => Promise.resolve(require(__rewriteRelativeImportExtension(specifier)));"
        );
        const rewritten = rewrittenAuthContext.replace(
          "const dynamicImport = (specifier) => import(__rewriteRelativeImportExtension(specifier));",
          "const dynamicImport = (specifier) => Promise.resolve(require(__rewriteRelativeImportExtension(specifier)));"
        );
        if (rewritten === source) {
          throw new Error(
            `Pi dynamic Node import helper changed: ${args.path}`
          );
        }
        return { loader: "js", contents: rewritten };
      }
    );
  }
};

/**
 * EchoInk exposes only Pi 0.82.1's OpenAI Codex OAuth flow. Pi deliberately
 * hides OAuth implementations behind a variable dynamic import for browser
 * builds, but an Obsidian single-file plugin has no package-relative module at
 * runtime. Rewrite only the OpenAI Codex loader to a static import and bridge
 * its Node builtins through the CommonJS path supported by Obsidian Node 20.
 */
const piOpenAICodexOAuthPlugin = {
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
        const rewritten = source.replace(original, `if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
    _randomBytes = require("node:crypto").randomBytes;
    _http = require("node:http");
}`);
        return {
          loader: "js",
          resolveDir: path.dirname(args.path),
          contents: rewritten
        };
      }
    );
  }
};

/**
 * Pi 0.82.1 publishes one ESM entry (`dist/index.js`) that re-exports the whole
 * CLI (main, interactive mode, package-manager CLI, clipboard, image helpers,
 * shell config) alongside the SDK. esbuild therefore bundles every dormant CLI
 * module — including the ZIP extraction / tool download installer and Windows
 * self-update code — into EchoInk's `dist/main.js`. EchoInk only needs the
 * narrow Runtime surface below, verified against the production imports in
 * `src/` (see pi-production-runtime-composition.ts, pi-local-data-service.ts
 * and the pi-native harness). Replace the entry with that surface so the CLI
 * and its download/self-update machinery are never pulled in.
 *
 * The upstream entry structure is pinned by an anchor check plus a package
 * version guard: if either drifts, the build fails and asks for a re-audit
 * instead of silently shipping an unreviewed entry.
 */
const PI_CODING_AGENT_VERSION = "0.82.1";
const piCodingAgentPackagePath = path.join(
  process.cwd(),
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "package.json"
);
const piCodingAgentInstalledVersion = JSON.parse(
  fs.readFileSync(piCodingAgentPackagePath, "utf8")
).version;
if (piCodingAgentInstalledVersion !== PI_CODING_AGENT_VERSION) {
  throw new Error(
    `@earendil-works/pi-coding-agent version changed `
      + `(${piCodingAgentInstalledVersion} !== ${PI_CODING_AGENT_VERSION}); `
      + "re-audit the EchoInk Pi runtime surface before building."
  );
}

const PI_PHOTON_VERSION = "0.3.4";
const PI_PHOTON_WASM_BYTE_LENGTH = 1_881_634;
const PI_PHOTON_WASM_SHA256 =
  "10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c";
const piPhotonPackageRoot = path.join(
  path.dirname(piCodingAgentPackagePath),
  "node_modules",
  "@silvia-odwyer",
  "photon-node"
);
const piPhotonPackagePath = path.join(piPhotonPackageRoot, "package.json");
const piPhotonWasmPath = path.join(piPhotonPackageRoot, "photon_rs_bg.wasm");
const piPhotonInstalledVersion = JSON.parse(
  fs.readFileSync(piPhotonPackagePath, "utf8")
).version;
if (piPhotonInstalledVersion !== PI_PHOTON_VERSION) {
  throw new Error(
    `Pi transitive @silvia-odwyer/photon-node version changed `
      + `(${piPhotonInstalledVersion} !== ${PI_PHOTON_VERSION}); `
      + "re-audit the embedded image runtime before building."
  );
}
const piPhotonWasmBytes = fs.readFileSync(piPhotonWasmPath);
const piPhotonWasmSha256 = createHash("sha256")
  .update(piPhotonWasmBytes)
  .digest("hex");
if (
  piPhotonWasmBytes.byteLength !== PI_PHOTON_WASM_BYTE_LENGTH
  || piPhotonWasmSha256 !== PI_PHOTON_WASM_SHA256
) {
  throw new Error(
    `Pi transitive Photon WASM changed `
      + `(${piPhotonWasmBytes.byteLength} bytes, sha256:${piPhotonWasmSha256}); `
      + "re-audit the embedded image runtime before building."
  );
}
const piPhotonWasmBrotliBase64 = brotliCompressSync(piPhotonWasmBytes, {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 }
}).toString("base64");

const piRuntimeSurfacePlugin = {
  name: "echoink-pi-runtime-surface",
  setup(build) {
    build.onLoad(
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]index\.js$/
      },
      async (args) => {
        const source = await fs.promises.readFile(args.path, "utf8");
        const requiredAnchors = [
          'export { main } from "./main.js";',
          "SessionManager",
          "createAgentSession",
          "ModelRuntime",
          'export { convertToPng } from "./utils/image-convert.js";',
          'export { formatDimensionNote, resizeImage } from "./utils/image-resize.js";'
        ];
        for (const anchor of requiredAnchors) {
          if (!source.includes(anchor)) {
            throw new Error(
              `Pi runtime entry changed; missing anchor: ${anchor}`
            );
          }
        }
        return {
          loader: "js",
          resolveDir: path.dirname(args.path),
          contents: `
export {
  CURRENT_SESSION_VERSION,
  SessionManager,
  sessionEntryToContextMessages
} from "./core/session-manager.js";

export { ModelRuntime } from "./core/model-runtime.js";
export { SettingsManager } from "./core/settings-manager.js";

export { createAgentSession } from "./core/sdk.js";

export {
  createExtensionRuntime,
  defineTool
} from "./core/extensions/index.js";

export { createSyntheticSourceInfo } from "./core/source-info.js";

export {
  loadSkills,
  formatSkillsForPrompt
} from "./core/skills.js";

export { convertToLlm } from "./core/messages.js";

export { convertToPng } from "./utils/image-convert.js";
export { resizeImage } from "./utils/image-resize.js";
`
        };
      }
    );
  }
};

/**
 * Photon 0.3.4's CommonJS entry synchronously reads photon_rs_bg.wasm next to
 * itself. Obsidian ships EchoInk as one main.js, so there is no package-local
 * WASM file at runtime. Keep Pi's public image helpers and the existing
 * transitive Photon implementation, but replace only that fixed file read with
 * the losslessly compressed, version- and hash-verified bytes captured above.
 * Decompression stays inside Photon's existing lazy, cached module load. The marker remains in
 * the built bundle so the post-build gate can prove this bridge was retained.
 */
const piPhotonRuntimePlugin = {
  name: "echoink-pi-photon-runtime",
  setup(build) {
    build.onLoad(
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]node_modules[\\/]@silvia-odwyer[\\/]photon-node[\\/]photon_rs\.js$/
      },
      async (args) => {
        const source = await fs.promises.readFile(args.path, "utf8");
        const original = `const path = require('path').join(__dirname, 'photon_rs_bg.wasm');
const bytes = require('fs').readFileSync(path);`;
        if (!source.includes(original) || !source.includes("wasm.__wbindgen_start();")) {
          throw new Error(
            "Photon 0.3.4 CommonJS loader changed; re-audit the embedded WASM bridge."
          );
        }
        const embedded = `const bytes = require("node:zlib").brotliDecompressSync(
  Buffer.from(${JSON.stringify(piPhotonWasmBrotliBase64)}, "base64")
);
if (bytes.byteLength !== ${PI_PHOTON_WASM_BYTE_LENGTH}
  || require("node:crypto").createHash("sha256").update(bytes).digest("hex") !== ${JSON.stringify(PI_PHOTON_WASM_SHA256)}) {
  throw new Error(${JSON.stringify(
    `EchoInk embedded Photon runtime mismatch: photon-node@${PI_PHOTON_VERSION} wasm sha256:${PI_PHOTON_WASM_SHA256}`
  )});
}`;
        return {
          loader: "js",
          resolveDir: path.dirname(args.path),
          contents: source.replace(original, embedded)
        };
      }
    );
  }
};

/**
 * Even after narrowing the entry, `createAgentSession` (core/sdk.js) and
 * `createExtensionRuntime` (core/extensions/index.js) statically import the
 * default Coding Tools, `DefaultResourceLoader`, the interactive theme, HTML
 * export, and jiti. EchoInk replaces every one of those code paths with its
 * own controlled equivalents (custom tools, controlled vault resource loader,
 * inline extensions, no interactive/HTML/bash/find/grep), so the modules below
 * are unreachable at runtime — yet esbuild still bundles them because the
 * imports are static.
 *
 * Replace each unreachable leaf module with a fail-closed stub (same export
 * names, throw on invocation) or, for pure-presentation helpers, an identity
 * passthrough. Each replacement is pinned by an anchor check against the
 * upstream source so a structural drift fails the build instead of silently
 * shipping a stale shim. This mirrors the existing `piControlledEgressPlugin`
 * pattern and never touches `node_modules`.
 */
const PI_LEAF_SHIM_FAIL =
  "EchoInk bundles a narrowed Pi runtime; this module is not reachable in the EchoInk configuration.";

/**
 * Generate the source of a `fail` factory for a fail-closed shim module.
 *
 * The returned string is a self-contained `const fail = ...` statement whose
 * error text is baked in as a literal (via JSON.stringify) — it must NOT
 * capture any closure variable, because the string is inlined into a virtual
 * module whose scope has none of them. `fail(name)` returns a function that
 * throws only when invoked, so `export const x = fail("x")` evaluates safely at
 * module load and fails closed on the first real call.
 */
function failFactory(label) {
  const message = `${PI_LEAF_SHIM_FAIL} ${label}`;
  return `(name) => () => {
  throw new Error(${JSON.stringify(message)} + ": " + name);
}`;
}

const piLeafModuleShimsPlugin = {
  name: "echoink-pi-leaf-module-shims",
  setup(build) {
    const shims = [
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]utils[\\/]tools-manager\.js$/,
        anchor: "extractZipArchive",
        contents: `
const fail = ${failFactory("Pi fd/rg tool downloader (tools-manager)")};
export function getToolPath(...args) { return fail("getToolPath")(...args); }
export async function ensureTool(...args) { return fail("ensureTool")(...args); }
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]modes[\\/]interactive[\\/]theme[\\/]theme\.js$/,
        anchor: "Theme not initialized",
        contents: `
const fail = ${failFactory("interactive theme")};
export const theme = new Proxy({}, {
  get(_t, prop) {
    if (prop === "then" || prop === Symbol.toPrimitive) return undefined;
    return (...args) => (typeof args[0] === "string" ? args[0] : args[0]);
  }
});
export class Theme {}
export function getThemeByName() { return undefined; }
export function loadThemeFromPath() { return null; }
export function getLanguageFromPath() { return undefined; }
export function highlightCode(code) { return code; }
export const getAvailableThemes = fail("getAvailableThemes");
export const getAvailableThemesWithPaths = fail("getAvailableThemesWithPaths");
export const parseAutoThemeSetting = fail("parseAutoThemeSetting");
export const resolveThemeSetting = fail("resolveThemeSetting");
export const getThemeForRgbColor = fail("getThemeForRgbColor");
export const detectTerminalBackgroundFromEnv = fail("detectTerminalBackgroundFromEnv");
export const detectTerminalBackgroundTheme = fail("detectTerminalBackgroundTheme");
export const detectTerminalThemeForAuto = fail("detectTerminalThemeForAuto");
export const getDefaultTheme = fail("getDefaultTheme");
export const setRegisteredThemes = fail("setRegisteredThemes");
export const initTheme = fail("initTheme");
export const setTheme = fail("setTheme");
export const setThemeInstance = fail("setThemeInstance");
export const onThemeChange = fail("onThemeChange");
export const stopThemeWatcher = fail("stopThemeWatcher");
export const getResolvedThemeColors = fail("getResolvedThemeColors");
export const isLightTheme = fail("isLightTheme");
export const getThemeExportColors = fail("getThemeExportColors");
export const getMarkdownTheme = fail("getMarkdownTheme");
export const getSelectListTheme = fail("getSelectListTheme");
export const getEditorTheme = fail("getEditorTheme");
export const getSettingsListTheme = fail("getSettingsListTheme");
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]utils[\\/]syntax-highlight\.js$/,
        anchor: "renderHighlightedHtml",
        contents: `
export function renderHighlightedHtml(html) { return html; }
export function highlight(code) { return code; }
export function supportsLanguage() { return false; }
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]core[\\/]export-html[\\/]index\.js$/,
        anchor: "exportSessionToHtml",
        contents: `
const fail = ${failFactory("HTML session export")};
export const exportSessionToHtml = fail("exportSessionToHtml");
export const exportFromFile = fail("exportFromFile");
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]core[\\/]export-html[\\/]tool-renderer\.js$/,
        anchor: "createToolHtmlRenderer",
        contents: `
const fail = ${failFactory("HTML tool renderer")};
export const createToolHtmlRenderer = fail("createToolHtmlRenderer");
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]core[\\/]package-manager\.js$/,
        anchor: "class DefaultPackageManager",
        contents: `
const fail = ${failFactory("default package manager")};
export const getExtensionTempFolder = fail("getExtensionTempFolder");
export class DefaultPackageManager { constructor() { fail("DefaultPackageManager")(); } }
`
      },
      {
        filter:
          /[\\/]@earendil-works[\\/]pi-ai[\\/]dist[\\/]providers[\\/]all\.js$/,
        anchor: "getBuiltinModelDataGeneratedAt",
        contents: `
// EchoInk registers its own native provider and never streams through Pi's
// built-in provider catalog. Return an empty catalog so the built-in provider
// implementations (OpenAI/Anthropic/Mistral/Google API modules) and their model
// metadata are never bundled. Every export keeps the upstream return-type
// contract (arrays for provider/model lists, real empty Models/ImagesModels
// collections for the collection factories) so callers like compatModels
// never see a bare object. radiusProvider is unreachable because EchoInk loads
// no models.json radius config; fail closed if it is ever requested.
import { createModels } from "../models.js";
import { createImagesModels } from "../images-models.js";

const fail = ${failFactory("built-in provider catalog")};
export function getBuiltinModel() { return undefined; }
export function getBuiltinProviders() { return []; }
export function getBuiltinModelDataGeneratedAt() { return undefined; }
export function getBuiltinModels() { return []; }
export function builtinProviders() { return []; }
export function builtinModels(options) { return createModels(options); }
export function builtinImagesProviders() { return []; }
export function builtinImagesModels(options) { return createImagesModels(options); }
export function radiusProvider() { return fail("radiusProvider")(); }
`
      }
    ];

    for (const shim of shims) {
      build.onLoad({ filter: shim.filter }, async (args) => {
        const source = await fs.promises.readFile(args.path, "utf8");
        if (!source.includes(shim.anchor)) {
          throw new Error(
            `Pi module changed (${shim.filter}); missing anchor: ${shim.anchor}`
          );
        }
        return {
          loader: "js",
          resolveDir: path.dirname(args.path),
          contents: shim.contents
        };
      });
    }

    // jiti is pulled only by core/extensions/loader.js to compile TypeScript
    // extension files loaded from disk. EchoInk registers inline extensions
    // and never loads extension files, so the 2.3 MB jiti/babel dependency is
    // unreachable; fail closed if a future path tries to use it.
    build.onResolve({ filter: /^jiti\/static$/ }, () => ({
      path: "jiti-static",
      namespace: "echoink-pi-jiti-shim",
      sideEffects: false
    }));
    build.onLoad(
      { filter: /.*/, namespace: "echoink-pi-jiti-shim" },
      () => ({
        loader: "js",
        contents: `
const fail = ${failFactory("jiti TypeScript extension loader")};
export function createJiti(...args) { return fail("createJiti")(...args); }
`
      })
    );
  }
};

/**
 * Configured cloud Providers stream through Pi's built-in OpenAI and
 * Anthropic clients, so those SDKs stay bundled for real. The remaining SDKs
 * (Google GenAI, Mistral) and the terminal TUI are unreachable from any
 * EchoInk product path — only dormant `lazyApi(() => import(...))` entries —
 * so they are replaced with fail-closed stubs to keep their multi-megabyte
 * transitive graphs (OpenTelemetry, google-auth, ws, yaml, bignumber) out of
 * the bundle.
 */
const PI_PROVIDER_SDK_SHIMS = {
  "@google/genai": `
const fail = ${failFactory("Google GenAI provider SDK")};
export class GoogleGenAI { constructor(...args) { fail("GoogleGenAI")(...args); } }
export const FinishReason = new Proxy({}, { get: (_t, p) => p });
export const FunctionCallingConfigMode = new Proxy({}, { get: (_t, p) => p });
export const ResourceScope = new Proxy({}, { get: (_t, p) => p });
export const ThinkingLevel = new Proxy({}, { get: (_t, p) => p });
export default GoogleGenAI;
`,
  "@mistralai/mistralai": `
const fail = ${failFactory("Mistral provider SDK")};
export class Mistral { constructor(...args) { fail("Mistral")(...args); } }
export default Mistral;
`,
  "@earendil-works/pi-tui": `
const fail = ${failFactory("Pi TUI rendering")};
export class Box { constructor(...args) { fail("Box")(...args); } }
export class Container { constructor(...args) { fail("Container")(...args); } }
export class Markdown { constructor(...args) { fail("Markdown")(...args); } }
export class Spacer { constructor(...args) { fail("Spacer")(...args); } }
export class Text { constructor(...args) { fail("Text")(...args); } }
export class Image { constructor(...args) { fail("Image")(...args); } }
export class Loader { constructor(...args) { fail("Loader")(...args); } }
export class CancellableLoader { constructor(...args) { fail("CancellableLoader")(...args); } }
export class SelectList { constructor(...args) { fail("SelectList")(...args); } }
export class SettingsList { constructor(...args) { fail("SettingsList")(...args); } }
export class Input { constructor(...args) { fail("Input")(...args); } }
export class Editor { constructor(...args) { fail("Editor")(...args); } }
export class ProcessTerminal { constructor(...args) { fail("ProcessTerminal")(...args); } }
export class TUI { constructor(...args) { fail("TUI")(...args); } }
export class TruncatedText { constructor(...args) { fail("TruncatedText")(...args); } }
export class CombinedAutocompleteProvider { constructor(...args) { fail("CombinedAutocompleteProvider")(...args); } }
export class KeybindingsManager { constructor(...args) { fail("KeybindingsManager")(...args); } }
export const getCapabilities = () => ({ hyperlinks: false, images: false, ansi: false, trueColor: false });
export const getKeybindings = fail("getKeybindings");
export const setKeybindings = fail("setKeybindings");
export const fuzzyFilter = fail("fuzzyFilter");
export const fuzzyMatch = fail("fuzzyMatch");
export const matchesKey = fail("matchesKey");
export const truncateToWidth = fail("truncateToWidth");
export const visibleWidth = fail("visibleWidth");
export const wrapTextWithAnsi = fail("wrapTextWithAnsi");
export const sliceByColumn = fail("sliceByColumn");
export const hyperlink = fail("hyperlink");
export const imageFallback = fail("imageFallback");
export const getImageDimensions = fail("getImageDimensions");
export const TUI_KEYBINDINGS = Object.freeze({});
export const Key = Object.freeze({});
export default {};
`
};

const piProviderSdkShimsPlugin = {
  name: "echoink-pi-provider-sdk-shims",
  setup(build) {
    build.onResolve(
      {
        filter:
          /^(?:@google\/genai|@mistralai\/mistralai|@earendil-works\/pi-tui)$/
      },
      (args) => ({
        path: args.path,
        namespace: "echoink-pi-provider-sdk-shim",
        sideEffects: false
      })
    );
    build.onLoad(
      { filter: /.*/, namespace: "echoink-pi-provider-sdk-shim" },
      (args) => {
        const contents = PI_PROVIDER_SDK_SHIMS[args.path];
        if (!contents) {
          throw new Error(`Unknown provider SDK shim requested: ${args.path}`);
        }
        return { loader: "js", contents };
      }
    );
  }
};

const context = await esbuild.context({
  banner: {
    js: `/* EchoInk Agent */
var __echoInkPiModuleUrl = require("node:url").pathToFileURL(
  require("node:path").join(require("node:path").parse(process.execPath).root, "__echoink_pi_runtime__", "main.js")
).href;`
  },
  // Pi publishes one ESM entry for its SDK and dormant CLI/TUI utilities.
  // Obsidian evaluates CJS without __filename/__dirname. Keep a synthetic URL
  // for those helpers, using the running host's filesystem root and URL rules
  // (including Windows drive letters), rather than the build machine's path.
  // Controlled Chat never uses Pi's package-relative CLI assets or extensions.
  define: {
    "process.env.NODE_ENV": JSON.stringify(isProd ? "production" : "development"),
    "import.meta.url": "__echoInkPiModuleUrl"
  },
  entryPoints: [
    isPiImageBundleProbe
      ? "scripts/pi-image-bundle-probe-entry.ts"
      : "src/main.ts"
  ],
  bundle: true,
  // Pi's published shrinkwrap keeps identical nested copies after npm dedupe.
  // Aliases resolve from this project's root, including package subpath exports.
  alias: {
    "@earendil-works/pi-ai": "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core": "@earendil-works/pi-agent-core",
    yaml: "yaml",
    typebox: "typebox"
  },
  loader: {
    ".md": "text",
    ".svg": "dataurl",
    ".webp": "dataurl"
  },
  external: [
    "obsidian",
    "electron",
    "child_process",
    "fs",
    "os",
    "path",
    "readline",
    "node:*",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr"
  ],
  format: "cjs",
  platform: "node",
  target: "es2022",
  logLevel: "info",
  sourcemap: isProd ? false : "inline",
  minify: isProd,
  metafile: isProd,
  treeShaking: true,
  plugins: [
    reactDomScriptResourcesPlugin,
    piBraceExpansionPlugin,
    piOpenAICodexOAuthPlugin,
    piRuntimeSurfacePlugin,
    piPhotonRuntimePlugin,
    piLeafModuleShimsPlugin,
    piProviderSdkShimsPlugin,
    piControlledEgressPlugin,
    piRendererNodeImportShimPlugin
  ],
  outfile: isPiImageBundleProbe
    ? ".tmp/pi-image-production-bundle-probe.cjs"
    : "dist/main.js"
});

if (isWatch) {
  await context.watch();
} else {
  const result = await context.rebuild();
  if (buildMode === "production") {
    fs.mkdirSync(".tmp", { recursive: true });
    fs.writeFileSync(".tmp/production-metafile.json", JSON.stringify(result.metafile));
  }
  await context.dispose();
}
