import type { DataAdapter } from "obsidian";
import { mobileAtomicFilePort } from "./finance-store";
import type { VaultMigrationIO } from "../storage/vault-data-migration";

export function mobileVaultMigrationIO(adapter: DataAdapter): VaultMigrationIO {
  return {
    read: file => mobileAtomicFilePort(adapter, file).read(true),
    write: async (file, bytes) => { const port = mobileAtomicFilePort(adapter, file); const before = await port.read(); await port.write(bytes, before); },
    remove: file => adapter.remove(file),
    fileExists: async file => (await adapter.stat(file))?.type === "file",
    list: async directory => await adapter.exists(directory) ? adapter.list(directory) : { files: [], folders: [] }
  };
}
