// A WebView-shaped fetch whose SSE chunks are released one at a time by the test.
export function gatedStreamFetch() {
  const calls = [], queued = [], waiting = [];
  const deliver = item => { const next = waiting.shift(); if (next) next(item); else queued.push(item); };
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status: 200, headers: { get: name => name === "content-type" ? "text/event-stream" : null }, text: async () => "",
      body: { getReader: () => ({ read: () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiting.push(resolve)), cancel: async () => {} }) } };
  };
  return {
    fetch, calls,
    send(delta, finish) { deliver({ done: false, value: new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`) }); },
    end() { deliver({ done: false, value: new TextEncoder().encode("data: [DONE]\n\n") }); deliver({ done: true }); }
  };
}
