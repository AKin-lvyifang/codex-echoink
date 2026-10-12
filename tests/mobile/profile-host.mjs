import { createHost } from "./host.mjs";

/** Mobile adapters reject renaming over an existing destination. */
export function createProfileHost(seed) {
  const host = createHost(seed);
  const rename = host.adapter.rename.bind(host.adapter);
  host.adapter.rename = async (from, to) => {
    if (await host.adapter.exists(to)) throw new Error("Destination file already exists!");
    await rename(from, to);
  };
  return host;
}
