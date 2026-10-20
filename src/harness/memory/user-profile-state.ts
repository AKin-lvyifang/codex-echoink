import { readFile } from "node:fs/promises";
import path from "node:path";
import { USER_PROFILE_STATE_SCHEMA } from "./personal-memory-contracts";
import { USER_PROFILE_STATE_RELATIVE_PATH, parseUserProfileState, migrateLegacyUserProfileState, type UserProfileState, type UserProfileStateInspection } from "./user-profile-core";
export * from "./user-profile-core";
const LEGACY_USER_PROFILE_STATE_SCHEMA = "echoink.user-profile.v1" as const;

const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type UserProfileJsonRead =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid"; reason: string }>
  | Readonly<{ kind: "value"; raw: Record<string, unknown> }>;

async function readUserProfileJson(filePath: string): Promise<UserProfileJsonRead> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ kind: "missing" });
    }
    throw error;
  }

  let text: string;
  try {
    text = FATAL_UTF8_DECODER.decode(bytes);
  } catch {
    return Object.freeze({ kind: "invalid", reason: "invalid_utf8" });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return Object.freeze({ kind: "invalid", reason: "unparseable_json" });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return Object.freeze({ kind: "invalid", reason: "invalid_json_root" });
  }
  return Object.freeze({ kind: "value", raw: raw as Record<string, unknown> });
}

/** Inspect and deterministically map v1 without ever filtering unknown keys. */
export async function inspectUserProfileStateFile(
  filePath: string
): Promise<UserProfileStateInspection> {
  const read = await readUserProfileJson(filePath);
  if (read.kind !== "value") return read;
  const { raw } = read;
  if (raw.schema === USER_PROFILE_STATE_SCHEMA) {
    const state = parseUserProfileState(raw);
    return state
      ? Object.freeze({ kind: "v2", state })
      : Object.freeze({ kind: "invalid", reason: "invalid_v2" });
  }
  if (raw.schema !== LEGACY_USER_PROFILE_STATE_SCHEMA) {
    return Object.freeze({ kind: "invalid", reason: "unknown_schema" });
  }
  const migrated = migrateLegacyUserProfileState(raw);
  return migrated.state
    ? Object.freeze({ kind: "v1", state: migrated.state })
    : Object.freeze({ kind: "invalid", reason: migrated.reason ?? "invalid_v1" });
}

export class UserProfileStateStore {
  readonly filePath: string;

  constructor(sharedUserRoot: string) {
    this.filePath = path.join(sharedUserRoot, USER_PROFILE_STATE_RELATIVE_PATH);
  }

  async read(): Promise<UserProfileState | null> {
    const read = await readUserProfileJson(this.filePath);
    if (read.kind === "missing") return null;
    if (read.kind === "invalid") {
      throw new Error(`user_profile_state_invalid:${read.reason}`);
    }
    const parsed = parseUserProfileState(read.raw);
    if (!parsed) throw new Error("user_profile_state_invalid:unsupported_or_damaged");
    return parsed;
  }
}
