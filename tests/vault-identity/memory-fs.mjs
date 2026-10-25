import path from "node:path";
import { constants } from "node:fs";

// Pure in-memory filesystem. These tests do not create or open any real Vault.
export function memoryFs() {
  const nodes = new Map([["/", { type: "directory", ino: 1 }]]);
  let inode = 2;
  const normalize = value => path.resolve(String(value));
  const error = (code, file) => Object.assign(new Error(`${code}: ${file}`), { code });
  const get = file => { const node = nodes.get(normalize(file)); if (!node) throw error("ENOENT", file); return node; };
  const stat = node => ({ size: node.bytes?.length ?? 0, dev: 1, ino: node.ino, nlink: 1, mode: 0o100600, mtimeMs: 1, ctimeMs: 1,
    isSymbolicLink: () => node.type === "symlink", isDirectory: () => node.type === "directory", isFile: () => node.type === "file" });
  const fs = {
    nodes,
    async mkdir(file, options = {}) {
      file = normalize(file);
      if (nodes.has(file)) { if (get(file).type !== "directory") throw error("EEXIST", file); return; }
      if (options.recursive) await fs.mkdir(path.dirname(file), options); else get(path.dirname(file));
      nodes.set(file, { type: "directory", ino: inode++ });
    },
    async lstat(file) { return stat(get(file)); },
    async stat(file) { return stat(get(file)); },
    async realpath(file) { get(file); return normalize(file); },
    async readFile(file, encoding) { const node = get(file); if (node.type !== "file") throw error("EISDIR", file); return encoding ? node.bytes.toString("utf8") : Buffer.from(node.bytes); },
    async writeFile(file, bytes, options = {}) {
      file = normalize(file); get(path.dirname(file));
      if (options.flag === "wx" && nodes.has(file)) throw error("EEXIST", file);
      nodes.set(file, { type: "file", ino: nodes.get(file)?.ino ?? inode++, bytes: Buffer.from(bytes) });
    },
    async copyFile(source, destination) { await fs.writeFile(destination, await fs.readFile(source)); },
    async readdir(file, options = {}) {
      file = normalize(file); if (get(file).type !== "directory") throw error("ENOTDIR", file);
      return [...nodes].filter(([key]) => key !== file && path.dirname(key) === file).map(([key, node]) => options.withFileTypes
        ? { name: path.basename(key), ...stat(node) } : path.basename(key));
    },
    async rename(source, destination) {
      source = normalize(source); destination = normalize(destination); get(source); get(path.dirname(destination));
      const moved = [...nodes].filter(([key]) => key === source || key.startsWith(`${source}/`));
      for (const [key] of moved) nodes.delete(key);
      for (const [key, node] of moved) nodes.set(destination + key.slice(source.length), node);
    },
    async unlink(file) { get(file); nodes.delete(normalize(file)); },
    async rm(file, options = {}) {
      file = normalize(file); if (!options.force) get(file);
      for (const key of [...nodes.keys()]) if (key === file || options.recursive && key.startsWith(`${file}/`)) nodes.delete(key);
    },
    async open(file, flags) {
      if (typeof flags === "number" && flags & constants.O_CREAT) await fs.writeFile(file, "", { flag: flags & constants.O_EXCL ? "wx" : "w" });
      else if (flags === "wx" || flags === "w") await fs.writeFile(file, "", { flag: flags }); else get(file);
      return { writeFile: bytes => fs.writeFile(file, bytes), readFile: encoding => fs.readFile(file, encoding),
        stat: () => fs.stat(file), chmod: async () => {}, sync: async () => {}, close: async () => {} };
    }
  };
  return fs;
}

export function memoryAdapter(fs, vaultRoot) {
  const resolve = relative => path.join(vaultRoot, relative);
  const relative = absolute => path.relative(vaultRoot, absolute).replaceAll("\\", "/");
  return {
    exists: async file => fs.nodes.has(resolve(file)),
    read: file => fs.readFile(resolve(file), "utf8"),
    write: (file, bytes) => fs.writeFile(resolve(file), bytes),
    mkdir: file => fs.mkdir(resolve(file), { recursive: true }),
    remove: file => fs.unlink(resolve(file)),
    rename: async (source, destination) => {
      if (fs.nodes.has(resolve(destination))) throw new Error("Adapter rename refuses overwrite");
      return fs.rename(resolve(source), resolve(destination));
    },
    rmdir: file => fs.rm(resolve(file), { recursive: true }),
    list: async file => {
      const entries = await fs.readdir(resolve(file), { withFileTypes: true });
      return { files: entries.filter(entry => entry.isFile()).map(entry => relative(path.join(resolve(file), entry.name))),
        folders: entries.filter(entry => entry.isDirectory()).map(entry => relative(path.join(resolve(file), entry.name))) };
    }
  };
}
