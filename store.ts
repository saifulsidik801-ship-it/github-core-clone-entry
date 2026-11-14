// The forge's store: one process, one in-memory model. Repositories own their
// git objects (content-addressed, SHA-1), their refs, their issues, comments and
// pull requests. Nothing here reads a clock or a random source: every timestamp
// the forge writes is a fixed constant, every id a sequence, so two runs that
// receive the same requests reach byte-identical state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { FIXED_EPOCH_SEC, FIXED_ISO_TIME, FORGE_IDENTITY } from './scenario.ts';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** git's tree-entry sort: a directory compares as if its name ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. Timestamp is always the fixed epoch. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH_SEC;
  const author = `${fields.author ?? FORGE_IDENTITY} ${timestamp} +0000`;
  const committer = `${fields.committer ?? FORGE_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: { object: string; type: GitObjectType; tag: string; message: string; tagger?: string; timestamp?: number }): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH_SEC;
  const tagger = `${fields.tagger ?? FORGE_IDENTITY} ${timestamp} +0000`;
  return Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- packfiles

function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile (version 2/3), resolving OFS_DELTA and REF_DELTA entries.
 * `resolveBase` supplies a base a thin pack leaves out. Throws on corruption.
 * inflateSync with {info:true} reports the zlib stream's consumed input length
 * in engine.bytesWritten, which is how one entry's end is found.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const actual = pack.subarray(trailerStart).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (actual !== expected) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: { type: GitObjectType; data: Buffer; oid: string };
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor on the server`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = { type, data, oid };
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return entry.resolved;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over the rest. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** True when a pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return actual === expected;
}

// ---------------------------------------------------------------- the store

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueSeq: number;
  comments: Map<number, IssueComment[]>;
  commentSeq: number;
  pulls: PullRequest[];
  pullSeq: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
  changes: number;
}

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Line diff counts via LCS (files here are small). */
function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n').filter((_, i, a) => !(i === a.length - 1 && oldText.endsWith('\n')));
  const newLines = newText === '' ? [] : newText.split('\n').filter((_, i, a) => !(i === a.length - 1 && newText.endsWith('\n')));
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS length with two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const lcs = prev[m] as number;
  return { additions: m - lcs, deletions: n - lcs };
}

export class Forge {
  readonly viewerLogin: string;
  readonly repos = new Map<string, Repo>();
  private repoIdSeq = 1;
  private repoCreatedSeq = 1;
  private globalIdSeq = 1;

  constructor(viewerLogin: string) {
    this.viewerLogin = viewerLogin;
  }

  nextGlobalId(): number {
    return this.globalIdSeq++;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const repo: Repo = {
      id: this.repoIdSeq++,
      name,
      owner: this.viewerLogin,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.repoCreatedSeq++,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      issueSeq: 1,
      comments: new Map(),
      commentSeq: 1,
      pulls: [],
      pullSeq: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Every object reachable from `roots` (commits, tags, trees, blobs). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isOid(root)) queue.push(root);
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `descendant` (or equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
    return false;
  }

  /** The nearest common ancestor of two commits (first hit from a BFS out of `b`). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length) {
      const oid = queueA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueA.push(parent);
      }
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift() as string;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueB.push(parent);
      }
    }
    return null;
  }

  /** The flattened file map of a commit: path -> {oid, mode}. */
  treeFiles(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return out;
    const rootTree = parseCommit(commit.data).tree;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(rootTree, '');
    return out;
  }

  /** Build a tree object (and its subtrees) from a flattened file map; returns the root tree oid. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The blob bytes at a commit's path, or null. */
  fileAt(repo: Repo, commitOid: string, path: string): Buffer | null {
    const files = this.treeFiles(repo, commitOid);
    const entry = files.get(path);
    if (!entry) return null;
    const blob = repo.objects.get(entry.oid);
    return blob && blob.type === 'blob' ? blob.data : null;
  }

  /** Diff two flattened file maps into per-file changes with line counts. */
  diffFileMaps(repo: Repo, base: Map<string, { oid: string; mode: string }>, head: Map<string, { oid: string; mode: string }>): FileChange[] {
    const changes: FileChange[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const deletions = countLines(oldText);
        changes.push({ path, status: 'removed', oldOid: b.oid, newOid: null, additions: 0, deletions, changes: deletions });
      } else if (!b && h) {
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const additions = countLines(newText);
        changes.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions, deletions: 0, changes: additions });
      } else if (b && h && b.oid !== h.oid) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const { additions, deletions } = lineDiffCounts(oldText, newText);
        changes.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions, deletions, changes: additions + deletions });
      }
    }
    return changes;
  }

  /**
   * The three-way merge check for a squash merge: the merge base's tree, the
   * head tip's tree and the base tip's tree. A path changed on both sides with
   * different results is a conflict.
   */
  mergeConflict(repo: Repo, headTip: string, baseTip: string): boolean {
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return false;
    const baseFiles = this.treeFiles(repo, base);
    const headFiles = this.treeFiles(repo, headTip);
    const baseTipFiles = this.treeFiles(repo, baseTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path)?.oid ?? null;
      const h = headFiles.get(path)?.oid ?? null;
      const t = baseTipFiles.get(path)?.oid ?? null;
      if (h !== b && t !== b && h !== t) return true;
    }
    return false;
  }

  /** Mergeable state for a pull request's head/base tips. */
  mergeableState(repo: Repo, headTip: string, baseTip: string): 'MERGEABLE' | 'CONFLICTING' {
    return this.mergeConflict(repo, headTip, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request onto its base branch: the merged tree is the
   * base tip's files with the head's changes (against the merge base) applied,
   * committed as one commit on top of the base tip. The pull request is closed
   * and marked merged. Returns the merge commit's oid, or the reason it could
   * not merge.
   */
  squashMerge(repo: Repo, pull: PullRequest): { ok: true; mergeSha: string } | { ok: false; reason: string } {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return { ok: false, reason: 'base branch does not exist' };
    if (this.mergeConflict(repo, pull.headSha, baseTip)) return { ok: false, reason: 'Merge conflict' };
    const mergeBase = this.mergeBase(repo, pull.headSha, baseTip);
    const baseFiles = mergeBase ? this.treeFiles(repo, mergeBase) : new Map<string, { oid: string; mode: string }>();
    const headFiles = this.treeFiles(repo, pull.headSha);
    const baseTipFiles = this.treeFiles(repo, baseTip);
    const merged = new Map(baseTipFiles);
    for (const [path, file] of headFiles) {
      const baseEntry = baseFiles.get(path);
      if (!baseEntry || baseEntry.oid !== file.oid) merged.set(path, file);
    }
    for (const path of baseFiles.keys()) {
      if (!headFiles.has(path)) merged.delete(path);
    }
    const treeOid = this.buildTreeFromFiles(repo, merged);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const mergeSha = this.putObject(repo, 'commit', buildCommit({ tree: treeOid, parents: [baseTip], message }));
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO_TIME;
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = mergeSha;
    return { ok: true, mergeSha };
  }

  /**
   * The objects a client actually holds, given its haves and its shallow
   * boundary: walk from the haves, but never past a shallow commit's parents —
   * a depth-1 clone holds its tip's tree and blob, not the tip's parent.
   */
  heldObjects(repo: Repo, haves: readonly string[], oldShallow: readonly string[]): Set<string> {
    const shallowSet = new Set(oldShallow);
    const held = new Set<string>();
    const queue = [...haves];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        queue.push(parseCommit(object.data).tree);
        if (!shallowSet.has(oid)) {
          for (const parent of parseCommit(object.data).parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return held;
  }

  /**
   * Plan a fetch: which objects to send, and the shallow boundary.
   * Depth d includes commits at distance 0..d-1 from the wants; the boundary
   * commits (distance d-1) are the new shallow list. Haves prune at send time.
   */
  planFetch(repo: Repo, wants: readonly string[], haves: readonly string[], oldShallow: readonly string[], depth?: number): FetchPlan {
    const haveObjects = this.heldObjects(repo, haves, oldShallow);

    // Walk wants with distances; tags unwrap to their target.
    const included = new Set<string>();
    const boundary = new Set<string>();
    const queue: Array<{ oid: string; dist: number }> = [];
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (!object) continue;
      if (object.type === 'tag') {
        included.add(want);
        queue.push({ oid: parseTag(object.data).object, dist: 0 });
      } else {
        queue.push({ oid: want, dist: 0 });
      }
    }
    const seenCommit = new Set<string>();
    while (queue.length) {
      const { oid, dist } = queue.shift() as { oid: string; dist: number };
      if (seenCommit.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        included.add(oid);
        queue.push({ oid: parseTag(object.data).object, dist });
        continue;
      }
      if (object.type !== 'commit') continue;
      seenCommit.add(oid);
      if (depth !== undefined && dist >= depth) continue;
      included.add(oid);
      if (depth !== undefined && dist === depth - 1) boundary.add(oid);
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) queue.push({ oid: parent, dist: dist + 1 });
    }
    // Objects: the included commits/tags and everything their trees name —
    // never their parents, which is exactly what a depth boundary cuts off.
    const wanted = new Set<string>();
    const stack = [...included];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (wanted.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      wanted.add(oid);
      if (object.type === 'commit') {
        stack.push(parseCommit(object.data).tree);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
    const objects: GitObject[] = [];
    for (const oid of [...wanted].sort()) {
      if (haveObjects.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) objects.push(object);
    }
    const shallow = [...boundary].sort();
    const unshallow = oldShallow.filter((oid) => included.has(oid) && !boundary.has(oid)).sort();
    return { objects, shallow, unshallow };
  }
}
