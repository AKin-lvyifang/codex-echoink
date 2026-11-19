import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';

export const vault = process.env.ECHOINK_PERF_VAULT ?? path.join(os.homedir(),'EchoInk-TestVaults/测试仓库-运行丝滑度验收');
export const out = path.resolve(process.env.ECHOINK_PERF_OUT ?? 'docs/internal/test-evidence/2026-11-13-运行丝滑度优化');
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function connect(options = {}) {
  // A named disposable Vault and its private port are mandatory. Never discover other instances.
  if (path.dirname(path.resolve(vault))!==path.join(os.homedir(),'EchoInk-TestVaults') || !path.basename(vault).startsWith('测试仓库-')) throw Error('disposable Vault required');
  const port = Number(process.env.ECHOINK_PERF_PORT ?? 19463);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = options.targetId ? targets.find(t=>t.type==='page'&&t.id===options.targetId)
    : targets.find(t => t.type === 'page' && t.url.startsWith('app://obsidian.md'));
  if (!target) throw Error('Obsidian page not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map(), listeners = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p?.reject(Error(JSON.stringify(msg.error))); else p?.resolve(msg.result); }
    else for (const cb of listeners.get(msg.method) ?? []) cb(msg.params);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, {resolve,reject}); ws.send(JSON.stringify({id:n,method,params})); });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const actual = await evaluate('(window.app ?? window.__smoothApp)?.vault.adapter.getBasePath()');
  if (actual !== vault) { ws.close(); throw Error(`Vault mismatch: ${actual}`); }
  await fs.mkdir(out, {recursive:true});
  if(process.env.ECHOINK_PERF_FOCUS!=='0')await send('Emulation.setFocusEmulationEnabled',{enabled:true});
  return {
    send, evaluate,
    on(method, cb) { const list = listeners.get(method) ?? []; list.push(cb); listeners.set(method,list); },
    close: () => ws.close(),
    async traceStart(screenshots = false, extraCategories = []) {
      await send('Tracing.start', {categories:'devtools.timeline,v8.execute,disabled-by-default-v8.compile,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-v8.cpu_profiler,blink.user_timing,loading' + (screenshots ? ',disabled-by-default-devtools.screenshot' : '') + (extraCategories.length ? ',' + extraCategories.join(',') : ''), options:'sampling-frequency=1000',transferMode:'ReturnAsStream'});
    },
    async traceEnd(name) {
      const done = new Promise(resolve => this.on('Tracing.tracingComplete', resolve));
      await send('Tracing.end');
      const {stream} = await done;
      const chunks = [];
      for (;;) { const part = await send('IO.read',{handle:stream}); chunks.push(part.base64Encoded ? Buffer.from(part.data,'base64') : Buffer.from(part.data)); if (part.eof) break; }
      await send('IO.close',{handle:stream});
      const data = Buffer.concat(chunks);
      await fs.writeFile(path.join(out,`${name}.trace.json.gz`),gzipSync(data));
      return JSON.parse(data);
    },
    async screenshot(name) { const {data}=await send('Page.captureScreenshot',{format:'png'}); await fs.writeFile(path.join(out,`${name}.png`),Buffer.from(data,'base64')); },
    async write(name, value) { await fs.writeFile(path.join(out,name),JSON.stringify(value,null,2)); }
  };
}

// Local diagnostic helper; do not pass credentials or real content through this CLI.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const c = await connect();
  try { console.log(JSON.stringify(await c.evaluate(process.argv[2]),null,2)); } finally { c.close(); }
}
