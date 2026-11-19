import { CAUSE } from "../causes";
import { NEXT } from "../next";
import type { ErrorCopy } from "../types";
import * as account from "./account";
import * as app from "./app";
import * as mcp from "./mcp";
import * as modules from "./modules";
import * as provider from "./provider";
import * as settings from "./settings";

type CodeTable = Readonly<Record<string, ErrorCopy>>;

// Built on first use, not at load time, so any file may import this module
// (and compose.ts) without a load-order cycle.
let codeTables: readonly CodeTable[] | undefined;
let sentenceIndex: Map<string, ErrorCopy> | undefined;

/** Every internal code with a user sentence, from one place. */
export function lookupErrorCode(code: string): ErrorCopy | null {
  codeTables ??= [app.APP_CODES, provider.PROVIDER_CODES, account.ACCOUNT_CODES, mcp.MCP_CODES, settings.SETTINGS_CODES, modules.MODULES_CODES];
  for (const table of codeTables) {
    if (Object.prototype.hasOwnProperty.call(table, code)) return table[code];
  }
  return null;
}

/** A shared sentence (either language) → its pair, so the other language can be shown. Covers CAUSE, NEXT and every codes table. */
export function knownCopyBySentence(text: string): ErrorCopy | null {
  if (!sentenceIndex) {
    const index = new Map<string, ErrorCopy>();
    const add = (copy: ErrorCopy) => { index.set(copy[0], copy); index.set(copy[1], copy); };
    for (const value of [CAUSE, NEXT, ...Object.values(account), ...Object.values(app), ...Object.values(mcp), ...Object.values(modules), ...Object.values(provider), ...Object.values(settings)] as unknown[]) {
      if (isErrorCopy(value)) add(value);
      else if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const entry of Object.values(value)) if (isErrorCopy(entry)) add(entry);
      }
    }
    sentenceIndex = index;
  }
  return sentenceIndex.get(text.trim()) ?? null;
}

function isErrorCopy(value: unknown): value is ErrorCopy {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string";
}
