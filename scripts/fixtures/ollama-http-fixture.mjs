import { createServer } from "node:http";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const OLLAMA_FIXTURE_MODEL = "qwen2.5:7b-instruct-q4_K_M";

// Ollama v0.12.6: openai/openai.go FromChatRequest (reasoning_effort ->
// Think), server/routes.go ChatHandler (non-thinking models reject Think).
// Unknown JSON fields are ignored, as with Go's JSON decoder. This is a
// protocol fixture, not inference or a substitute for a real model test.
export function ollamaRequestError(body) {
  const effort = body.reasoning?.effort ?? body.reasoning_effort;
  if (effort && !["high", "medium", "low", "none"].includes(effort)) {
    return `invalid reasoning value: '${effort}' (must be "high", "medium", "low", or "none")`;
  }
  if (body.model === OLLAMA_FIXTURE_MODEL && effort && effort !== "none") {
    return `"${body.model}" does not support thinking`;
  }
  return null;
}

export function createOllamaHttpFixture({ capture, errorOverride } = {}) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ object: "list", data: [{ id: OLLAMA_FIXTURE_MODEL, object: "model", owned_by: "library" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const error = await errorOverride?.() || ollamaRequestError(body);
      await capture?.({ body, status: error ? 400 : 200, error });
      if (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: error, type: "invalid_request_error", param: null, code: null } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "chatcmpl-ollama-fixture", object: "chat.completion.chunk", created: 1793260000, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      response.write(chunk({ role: "assistant", content: "你好！" }));
      response.write(chunk({ content: "我是本机假 Ollama 服务的验收回复。今天有什么想聊的吗？" }));
      response.end(chunk({}, "stop") + "data: [DONE]\n\n");
    } catch {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "invalid request body" } }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const capturePath = process.argv[2];
  const errorPath = process.argv[3];
  const server = createOllamaHttpFixture({
    capture: capturePath ? record => appendFile(capturePath, JSON.stringify(record) + "\n") : undefined,
    errorOverride: errorPath ? async () => { try { return (await readFile(errorPath, "utf8")).trim(); } catch { return ""; } } : undefined
  });
  server.listen(11439, "127.0.0.1", () => console.log("Fake Ollama listening at http://127.0.0.1:11439/v1"));
}
