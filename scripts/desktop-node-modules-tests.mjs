import assert from "node:assert/strict";
import { createRequire, isBuiltin } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const modules = {
  getDesktopFs: "node:fs", getDesktopFsPromises: "node:fs/promises",
  getDesktopPath: "node:path", getDesktopOs: "node:os", getDesktopUrl: "node:url",
  getDesktopCrypto: "node:crypto", getDesktopChildProcess: "node:child_process",
  getDesktopHttp: "node:http", getDesktopHttps: "node:https", getDesktopNet: "node:net",
  getDesktopUtil: "node:util", getDesktopBuffer: "node:buffer", getDesktopModule: "node:module"
};
const adapters = ["filesystem", "paths", "crypto", "process", "network", "runtime"];
const built = await esbuild.build({
  stdin: { contents: adapters.map(name => `export * from "./src/platform/desktop-${name}";`).join("\n"), resolveDir: process.cwd(), loader: "ts" },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["obsidian"], logLevel: "silent"
});
const nativeRequire = createRequire(import.meta.url);
for (const desktop of [false, true]) {
  const Platform = { isDesktop: desktop, isMobileApp: !desktop };
  const loaded = [];
  const module = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, {
    module, exports: module.exports,
    require(id) {
      if (id === "obsidian") return { Platform };
      assert.ok(isBuiltin(id), `unexpected dependency: ${id}`);
      loaded.push(id);
      assert.equal(Platform.isDesktop, true, "Node must never load outside desktop");
      return nativeRequire(id);
    }
  });
  assert.deepEqual(loaded, [], "importing adapters must not eagerly load any Node module");
  for (const [name, id] of Object.entries(modules)) {
    if (desktop) assert.equal(module.exports[name](), nativeRequire(id), `${name} must retain the original Node module`);
    else assert.throws(() => module.exports[name](), /requires? desktop Obsidian/);
  }
  assert.equal(loaded.length, desktop ? Object.keys(modules).length : 0);
  if (desktop) {
    Platform.isDesktop = false;
    const count = loaded.length;
    for (const name of Object.keys(modules)) assert.throws(() => module.exports[name](), /requires? desktop Obsidian/);
    assert.equal(loaded.length, count, "previous desktop loads must not bypass the guard");
  }
}
console.log("Desktop Node boundary: 13 native module identities preserved; mobile calls rejected before require; imports load no Node modules.");

const transportBuild = await esbuild.build({
  entryPoints: ["src/resources/json-rpc-stdio-transport.ts"],
  bundle: true, write: false, platform: "node", format: "cjs", external: ["obsidian"], logLevel: "silent"
});
const transportModule = { exports: {} };
vm.runInNewContext(transportBuild.outputFiles[0].text, {
  module: transportModule, exports: transportModule.exports,
  window: { setTimeout, clearTimeout },
  require(id) { return id === "obsidian" ? { Platform: { isDesktop: true } } : nativeRequire(id); }
});
class EchoTransport extends transportModule.exports.JsonRpcStdioTransport {
  buildCommand() {
    return { command: process.execPath, args: ["-e", `let buffer="";process.stdin.on("data",chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf("\\n"))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:m.params})+"\\n");}});`] };
  }
  handleMessage() {}
}
const transport = new EchoTransport();
try {
  transport.start();
  const result = await transport.request("fixture/echo", { value: "native-stdio" }, 3000);
  assert.equal(result.value, "native-stdio");
} finally { await transport.dispose(); }
console.log("Desktop MCP process boundary: real child-process stdio request/response and disposal passed.");
