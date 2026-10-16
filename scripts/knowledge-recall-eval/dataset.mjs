import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DIGEST_ALGORITHM = 'sha256-path-content-u64be-v1';
export const DIGEST_EXCLUDED_FIELDS = ['manifest.json#/content_sha256'];
export const RULE_VERSION = 'kb-recall-mechanical-v1';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function relativeFile(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe relative path: ${name}`);
  return path.join(root, ...name.split('/'));
}

// Every regular file participates. Symlinks and special files are never followed.
export async function datasetFiles(root) {
  const resolved = path.resolve(root);
  if ((await lstat(resolved)).isSymbolicLink()) throw new Error('Dataset root must not be a symlink');
  if (await realpath(resolved) !== resolved) throw new Error('Dataset ancestors must not be symlinks');
  const files = [];
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = relativeFile(resolved, name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error(`Dataset symlink rejected: ${name}`);
      if (stat.isDirectory()) await visit(full, name);
      else if (stat.isFile()) files.push(name);
      else throw new Error(`Dataset special file rejected: ${name}`);
    }
  }
  await visit(resolved, '');
  return files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}

function lengthFrame(length) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(length));
  return bytes;
}

export async function digestDataset(root) {
  const files = await datasetFiles(root);
  if (!files.includes('manifest.json') || !files.includes('cases.jsonl')) throw new Error('Dataset requires manifest.json and cases.jsonl');
  const hash = createHash('sha256').update(`${DIGEST_ALGORITHM}\0`, 'utf8');
  const entries = [];
  for (const name of files) {
    let content = await readFile(relativeFile(root, name));
    if (name === 'manifest.json') {
      const manifest = JSON.parse(content.toString('utf8'));
      delete manifest.content_sha256;
      content = Buffer.from(canonicalJson(manifest), 'utf8');
    }
    const encodedName = Buffer.from(name, 'utf8');
    hash.update(lengthFrame(encodedName.length)).update(encodedName).update(lengthFrame(content.length)).update(content);
    entries.push({ path: name, hashed_bytes: content.length });
  }
  return { content_sha256: hash.digest('hex'), file_count: files.length, entries };
}

export async function freezeDataset(root) {
  await datasetFiles(root);
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.content_sha256) return verifyDataset(root);
  manifest.digest_algorithm = DIGEST_ALGORITHM;
  manifest.digest_excluded_fields = DIGEST_EXCLUDED_FIELDS;
  manifest.scoring_rule_version ??= RULE_VERSION;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const digest = await digestDataset(root);
  manifest.content_sha256 = digest.content_sha256;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return verifyDataset(root);
}

export async function verifyDataset(root) {
  const digest = await digestDataset(root);
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.digest_algorithm !== DIGEST_ALGORITHM || canonicalJson(manifest.digest_excluded_fields) !== canonicalJson(DIGEST_EXCLUDED_FIELDS)) throw new Error('Dataset digest algorithm/exclusion metadata does not match this evaluator');
  if (manifest.scoring_rule_version !== RULE_VERSION) throw new Error(`Unsupported scoring rule: ${manifest.scoring_rule_version}`);
  if (!/^[a-f0-9]{64}$/.test(manifest.content_sha256 ?? '') || manifest.content_sha256 !== digest.content_sha256) throw new Error(`Dataset digest mismatch: expected ${manifest.content_sha256 ?? '(not frozen)'}, actual ${digest.content_sha256}`);
  return { manifest, digest };
}

export async function readCases(root) {
  const text = await readFile(path.join(root, 'cases.jsonl'), 'utf8');
  const seen = new Set();
  return text.split(/\r?\n/u).filter(line => line.trim()).map((line, index) => {
    const item = JSON.parse(line);
    if (typeof item.case_id !== 'string' || !item.case_id || seen.has(item.case_id)) throw new Error(`Missing/duplicate case_id at line ${index + 1}`);
    seen.add(item.case_id);
    return item;
  });
}
