import { folderFixture } from "../mobile-knowledge-folders/host.mjs";
import { createHash } from "node:crypto";

export const digest = text => createHash("sha256").update(text).digest("hex");
const stable = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
function events(target) {
  const refs = new Set();
  target.on = (name, callback) => { const ref = { name, callback }; refs.add(ref); return ref; };
  target.offref = ref => { refs.delete(ref); };
  return { emit(name) { for (const ref of [...refs]) if (ref.name === name) ref.callback(); }, get size() { return refs.size; } };
}
export async function pageFixture(api, root, seed) {
  const fixture = await folderFixture(api, root, seed);
  const vaultEvents = events(fixture.app.vault), metadataEvents = events(fixture.app.metadataCache);
  const leaves = [], graph = { fallback: false, fail: false };
  fixture.app.workspace = { layoutReady: true, getLeavesOfType: () => [{ existing: true }],
    getLeaf(type) {
      if (graph.fail) throw Error("graph unavailable");
      const leaf = { type, state: {}, options: {}, detached: false, revealed: false,
        async setViewState(value) { this.state = value; }, getViewState() { return this.state; }, detach() { this.detached = true; } };
      const engine = { setOptions(options) { leaf.options = options; }, getOptions: () => leaf.options, onOptionsChange: Object.assign(() => {}, { cancel() { leaf.cancelled = true; } }) };
      leaf.view = graph.fallback ? {} : { dataEngine: engine }; leaves.push(leaf); return leaf;
    }, async revealLeaf(leaf) { leaf.revealed = true; } };
  const original = api.MobileServices.prototype.readMaintenanceRecord;
  fixture.services.readMaintenanceRecord = id => original.call({ app: fixture.app, preferenceRoot: ".obsidian/plugins/echoink" }, id);
  const service = new api.MobileKnowledgePageService(fixture.services);
  return { ...fixture, service, vaultEvents, metadataEvents, leaves, graph,
    async record(value) { await fixture.write(`.obsidian/plugins/echoink/pi-agent-product-v1/knowledge/records/${value.recordId}.json`, JSON.stringify({ schemaVersion: 1, kind: "record", vaultId: "fixture", payload: value, payloadDigest: digest(stable(value)) })); },
    resolve(edges = {}) {
      fixture.app.metadataCache.resolvedLinks = Object.fromEntries(fixture.app.vault.getMarkdownFiles().map(file => [file.path, edges[file.path] ?? {}]));
      metadataEvents.emit("resolved");
    } };
}
