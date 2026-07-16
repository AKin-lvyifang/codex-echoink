import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2";

export type OpenCodeAuthPrompt = NonNullable<ProviderAuthMethod["prompts"]>[number];

export interface OpenCodeAuthorizationConnectionOverrides {
  serverUrl: "";
  autoStart: true;
  hostname: "127.0.0.1";
  port: 0;
  requireOwnedServer: true;
}

export function openCodeAuthorizationConnectionOverrides(): OpenCodeAuthorizationConnectionOverrides {
  return {
    serverUrl: "",
    autoStart: true,
    hostname: "127.0.0.1",
    port: 0,
    requireOwnedServer: true
  };
}

export function openCodeAutomaticOAuthInstructions(
  authorization: Pick<ProviderAuthAuthorization, "method"> & { instructions?: string | null }
): string | null {
  if (authorization.method !== "auto") return null;
  return authorization.instructions?.trim() || "请按浏览器页面提示完成授权。";
}

export function redactOpenCodeAuthSecrets(value: string, secrets: Iterable<string>): string {
  let redacted = String(value ?? "");
  const variants = new Set<string>();
  for (const secret of secrets) {
    const normalized = secret.trim();
    if (!normalized) continue;
    addOpenCodeSecretVariants(variants, normalized);
  }
  const normalized = Array.from(variants)
    .sort((left, right) => right.length - left.length);
  for (const secret of normalized) redacted = redacted.split(secret).join("[已隐藏]");
  return redacted;
}

function addOpenCodeSecretVariants(target: Set<string>, secret: string): void {
  const normalizedForms = new Set([secret, secret.normalize("NFC"), secret.normalize("NFD")]);
  for (const normalized of normalizedForms) {
    if (!normalized) continue;
    target.add(normalized);

    const uriEncoded = encodeURIComponent(normalized);
    addPercentEncodingVariants(target, uriEncoded);
    addPercentEncodingVariants(target, uriEncoded.replace(/%20/gi, "+"));
    addPercentEncodingVariants(target, encodeURIComponent(uriEncoded));

    const json = JSON.stringify(normalized);
    target.add(json);
    if (json.length >= 2) target.add(json.slice(1, -1));
    const slashEscaped = json.replace(/\//g, "\\/");
    target.add(slashEscaped);
    if (slashEscaped.length >= 2) target.add(slashEscaped.slice(1, -1));
    const asciiJsonEscaped = jsonEscapeNonAscii(normalized);
    target.add(asciiJsonEscaped);
    target.add(`"${asciiJsonEscaped}"`);

    const bytes = Buffer.from(normalized, "utf8");
    const base64 = bytes.toString("base64");
    target.add(base64);
    target.add(base64.replace(/=+$/, ""));
    target.add(base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    target.add(bytes.toString("hex"));
  }
}

function addPercentEncodingVariants(target: Set<string>, value: string): void {
  target.add(value);
  target.add(value.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
}

function jsonEscapeNonAscii(value: string): string {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const char = value[index];
    if (char === '"') escaped += '\\"';
    else if (char === "\\") escaped += "\\\\";
    else if (char === "\b") escaped += "\\b";
    else if (char === "\f") escaped += "\\f";
    else if (char === "\n") escaped += "\\n";
    else if (char === "\r") escaped += "\\r";
    else if (char === "\t") escaped += "\\t";
    else if (code < 0x20 || code > 0x7e) escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    else escaped += char;
  }
  return escaped;
}

export function shouldRequestOpenCodeAuthPrompt(
  prompt: OpenCodeAuthPrompt,
  inputs: Readonly<Record<string, string>>
): boolean {
  if (!prompt.when) return true;
  const actual = inputs[prompt.when.key] ?? "";
  return prompt.when.op === "eq"
    ? actual === prompt.when.value
    : actual !== prompt.when.value;
}

export function openCodeApiCredential(
  method: ProviderAuthMethod,
  inputs: Readonly<Record<string, string>>
): { key: string; metadata: Record<string, string> } | null {
  const entries = Object.entries(inputs).filter(([, value]) => value.trim());
  if (!entries.length) return null;
  const preferred = entries.find(([name]) => /(?:api.?key|token|secret|credential|password)/i.test(name))
    ?? (() => {
      const textKeys = (method.prompts ?? [])
        .filter((prompt) => prompt.type === "text" && entries.some(([name]) => name === prompt.key))
        .map((prompt) => prompt.key);
      return textKeys.length === 1 ? entries.find(([name]) => name === textKeys[0]) : undefined;
    })();
  if (!preferred) return null;
  const metadata = Object.fromEntries(entries.filter(([name]) => name !== preferred[0]));
  const key = preferred[1].trim();
  if (!key || method.type !== "api") return null;
  return { key, metadata };
}
