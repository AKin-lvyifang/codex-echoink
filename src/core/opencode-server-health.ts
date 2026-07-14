import * as http from "node:http";
import * as https from "node:https";

const DEFAULT_HEALTH_TIMEOUT_MS = 800;
const MAX_HEALTH_BODY_BYTES = 16 * 1024;

export async function isOpenCodeServerHealthy(serverUrl: string, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<boolean> {
  let target: URL;
  try {
    target = new URL("global/health", `${serverUrl.replace(/\/+$/, "")}/`);
  } catch {
    return false;
  }
  const transport = target.protocol === "https:" ? https : target.protocol === "http:" ? http : null;
  if (!transport) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      resolve(healthy);
    };
    const request = transport.get(target, { headers: { accept: "application/json" } }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_HEALTH_BODY_BYTES) {
          response.destroy();
          finish(false);
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", () => finish(false));
      response.once("end", () => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) return finish(false);
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { healthy?: unknown };
          finish(body.healthy === true);
        } catch {
          finish(false);
        }
      });
    });
    request.setTimeout(Math.max(100, timeoutMs), () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
  });
}
