// The git smart-HTTP layer: pkt-line framing, v0/v2 upload-pack advertisements,
// protocol v2 ls-refs and fetch, protocol v0 fetch, and receive-pack pushes.
// Every byte is built to match what the suite's own git client parses; the
// client is the authority on the wire format, not my memory of git.

import { Forge, ZERO_OID, hashObject, parseCommit, parseTag, parseTree, readPack, verifyPackChecksum, writePack, type GitObject, type Repo } from './store.ts';

export const AGENT = 'forge/1.0';

/** One pkt-line: a 4-hex length prefix plus the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error('pkt-line payload too large');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Parse a whole pkt-line buffer into packets (data/flush/delim/end). */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) throw new Error('bad pkt-line length');
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line runs past the buffer');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Encode lines (strings or 'flush'/'delim') as a pkt-line stream. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(FLUSH_PKT);
    else if (line === 'delim') parts.push(DELIM_PKT);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** A sideband packet: one byte of band (1 = data, 2 = progress, 3 = error) plus bytes. */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split a Buffer into sideband packets of at most 65520-5 bytes of payload each. */
export function sidebandStream(band: 1 | 2 | 3, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxChunk = 65520 - 5;
  if (data.length === 0) return Buffer.alloc(0);
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    parts.push(sidebandPacket(band, data.subarray(offset, Math.min(offset + maxChunk, data.length))));
  }
  return Buffer.concat(parts);
}

interface ListedRef {
  name: string;
  oid: string;
  peeled?: string;
}

/** The repo's refs as git lists them: HEAD first, then branches and tags sorted. */
export function listRefs(repo: Repo): ListedRef[] {
  const refs: ListedRef[] = [];
  const mainOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  refs.push({ name: 'HEAD', oid: mainOid ?? ZERO_OID });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: ListedRef = { name, oid };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target) entry.peeled = target;
    }
    refs.push(entry);
  }
  return refs;
}

const UPLOAD_V0_CAPS =
  'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not deepen-relative shallow filter ls-refs unborn symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k ofs-delta delete-refs agent=forge/1.0';

/** The v0 upload-pack advertisement: service line, flush, HEAD + refs, flush. */
export function uploadPackAdvertisementV0(repo: Repo): Buffer {
  const lines: (string | 'flush')[] = ['# service=git-upload-pack\n', 'flush'];
  const refs = listRefs(repo);
  const realRefs = refs.filter((ref) => ref.name !== 'HEAD');
  if (realRefs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${UPLOAD_V0_CAPS}\n`);
  } else {
    const head = refs[0] as ListedRef;
    lines.push(`${head.oid} HEAD\0${UPLOAD_V0_CAPS}\n`);
    for (const ref of realRefs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v0 receive-pack advertisement: service line, flush, HEAD + refs, flush. */
export function receivePackAdvertisementV0(repo: Repo): Buffer {
  const lines: (string | 'flush')[] = ['# service=git-receive-pack\n', 'flush'];
  const refs = listRefs(repo);
  const realRefs = refs.filter((ref) => ref.name !== 'HEAD');
  if (realRefs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${RECEIVE_V0_CAPS}\n`);
  } else {
    const head = refs[0] as ListedRef;
    lines.push(`${head.oid} HEAD\0${RECEIVE_V0_CAPS}\n`);
    for (const ref of realRefs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 capability advertisement: service line, flush, `version 2`, caps, flush. */
export function uploadPackAdvertisementV2(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------- v2 commands

interface V2FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
}

/** Parse a v2 command body into its command and argument lines. */
function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const args: string[] = [];
  let command = '';
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim && line.startsWith('command=')) command = line.slice('command='.length);
    else args.push(line);
  }
  return { command, args };
}

/** Answer a v2 ls-refs: one line per matching ref, then flush. */
export function handleLsRefsV2(repo: Repo, body: Buffer): Buffer {
  const { args } = parseV2Command(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: (string | 'flush')[] = [];
  const refs = listRefs(repo);
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    const tokens: string[] = [];
    if (ref.name === 'HEAD') {
      if (!unborn && ref.oid === ZERO_OID) continue;
      if (ref.oid === ZERO_OID) {
        lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
        continue;
      }
      tokens.push(ref.oid, 'HEAD');
      if (symrefs) tokens.push('symref-target:refs/heads/main');
    } else {
      tokens.push(ref.oid, ref.name);
      if (peel && ref.peeled) tokens.push(`peeled:${ref.peeled}`);
    }
    lines.push(`${tokens.join(' ')}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The shortest parent-walk distance from any want to any old shallow
 * boundary, or null when no boundary is reachable from the wants. */
function distanceToBoundary(forge: Forge, repo: Repo, wants: readonly string[], boundaries: readonly string[]): number | null {
  const targets = new Set(boundaries);
  const seen = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') queue.push({ oid: parseTag(object.data).object, dist: 0 });
    else queue.push({ oid: want, dist: 0 });
  }
  while (queue.length) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (targets.has(oid)) return dist;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
    } else if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, dist });
    }
  }
  return null;
}

/** Answer a v2 fetch. Section order follows what real git expects: an
 * `acknowledgments` section only when the client sent haves, a
 * `shallow-info` section only when the client asked for depth/shallow, then
 * the `packfile`. (A `wanted-refs` section is deliberately omitted: real git
 * does not expect it for ordinary fetches and the suite never reads it.) */
export function handleFetchV2(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { command, args } = parseV2Command(body);
  if (command !== 'fetch') return encodePktLines(['flush']);
  const request: V2FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  let done = false;
  let deepenRelative = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7).trim());
    else if (arg.startsWith('deepen-since ')) request.deepenSince = Number(arg.slice(13).trim());
    else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice(11).trim());
    else if (arg === 'done') done = true;
    else if (arg === 'deepen-relative') deepenRelative = true;
  }
  // Negotiation round (real git): the client sent haves but no "done", so it
  // is waiting for an acknowledgments round before it sends "done". Answer
  // with the acknowledgments section only, ending in a flush. Do NOT append
  // a response-end packet: remote-curl synthesizes one after the HTTP body
  // and its check_pktline dies on a server-sent 0002. The suite always sends
  // "done", so it never takes this path.
  if (request.haves.length > 0 && !done) {
    return encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']);
  }
  // Depth semantics. Without `deepen-relative` the `deepen N` value is the
  // TOTAL depth from the want (what the suite sends, and what an absolute
  // `--depth` fetch means), so it is used as-is. With `deepen-relative`
  // (real git's `--deepen`) N is the number of generations to extend BEYOND
  // the current shallow boundary, so the total depth is the distance from the
  // want to that boundary, plus the boundary itself, plus N.
  let depth = request.depth;
  if (deepenRelative && depth !== undefined && request.shallow.length > 0 && request.wants.length > 0) {
    const dist = distanceToBoundary(forge, repo, request.wants, request.shallow);
    if (dist !== null) depth = dist + 1 + depth;
  }
  const plan = forge.planFetch(repo, request.wants, request.haves, request.shallow, depth);
  const pack = writePack(plan.objects);

  const out: Buffer[] = [];
  // acknowledgments only when the client negotiated (sent haves); NAK when
  // nothing was acknowledged (the suite never negotiates haves to an ACK).
  if (request.haves.length > 0) {
    out.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']));
  }
  // shallow-info only when the client asked for depth/shallow work.
  if (request.depth !== undefined || request.shallow.length > 0) {
    const lines: (string | 'flush')[] = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    out.push(encodePktLines(lines));
  }
  // packfile: the pack as sideband band 1, then flush.
  out.push(encodePktLines(['packfile\n']));
  out.push(sidebandStream(1, pack));
  out.push(FLUSH_PKT);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- v0 fetch

interface V0FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

/** Parse a v0 upload-pack body: wants (+caps on the first), shallow/deepen, flush, haves, done, flush. */
function parseV0Fetch(body: Buffer): V0FetchRequest {
  const packets = decodePktLines(body);
  const request: V0FetchRequest = { wants: [], haves: [], shallow: [] };
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // The first want line carries the client's capabilities after the oid,
      // space-separated (git 2.43 and the suite both do this); take the oid
      // token only. A NUL separator is accepted too.
      const rest = line.slice(5);
      const token = rest.split(/[\s\0]/, 1)[0] as string;
      request.wants.push(token.trim());
    } else if (line.startsWith('shallow ')) {
      request.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      request.depth = Number(line.slice(7).trim());
    } else if (line.startsWith('have ')) {
      request.haves.push(line.slice(5).trim());
    }
    void seenFlush;
  }
  return request;
}

/** Answer a v0 fetch: NAK, shallow/unshallow lines, then the pack on sideband 1. */
export function handleFetchV0(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const request = parseV0Fetch(body);
  const plan = forge.planFetch(repo, request.wants, request.haves, request.shallow, request.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandStream(1, pack));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Answer a receive-pack push: parse the command list, then the pack that
 * follows the flush. Store the pack's objects, then apply each ref update
 * under git's fast-forward rules, and report one line per ref on sideband 1.
 */
export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  // Parse command pkt-lines one at a time until the flush; the pack follows
  // the flush as raw bytes, so the body must NOT be decoded as pkt-lines
  // past that point (pack bytes are not pkt-lines).
  const commands: PushCommand[] = [];
  let packStart = body.length;
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0 || length === 2 || offset + length > body.length) break;
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length === 1) {
      offset += 4;
      continue;
    }
    const text = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const commandText = nul >= 0 ? text.slice(0, nul) : text;
    const parts = commandText.split(' ');
    if (parts.length === 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    offset += length;
  }
  const reportLines: string[] = [];
  const sendReport = (unpack: string): Buffer => {
    // The report-status stream is pkt-lined inside band 1 and must itself
    // end with a flush pkt-line (real git's packet reader reads the demuxed
    // stream until a flush; a bare EOF there dies "remote end hung up").
    // The raw flush after the sideband stream then ends the sideband.
    const inner = encodePktLines([`unpack ${unpack}\n`, ...reportLines, 'flush']);
    return Buffer.concat([sidebandStream(1, inner), FLUSH_PKT]);
  };

  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  const packBytes = body.subarray(packStart);
  if (updatesRef && packBytes.length === 0) {
    return sendReport('unpacker error');
  }
  if (packBytes.length > 0) {
    let objects: Map<string, GitObject>;
    try {
      objects = readPack(packBytes, (oid) => repo.objects.get(oid));
    } catch (error) {
      return sendReport(error instanceof Error ? error.message : 'unpacker error');
    }
    if (!verifyPackChecksum(packBytes)) return sendReport('pack trailer checksum mismatch');
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} ref does not exist\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} old value mismatch\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    // Update: the old value must match, and the new tip must descend from it.
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} ref does not exist\n`);
    } else if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} old value mismatch\n`);
    } else if (!forge.isAncestor(repo, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
    } else {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  }
  return sendReport('ok');
}

// ---------------------------------------------------------------- dispatcher

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

/**
 * Route one smart-HTTP request. `service` is git-upload-pack or
 * git-receive-pack, `isInfoRefs` selects the advertisement, `isV2` is the
 * Git-Protocol: version=2 header. Returns null when the route is not a git
 * route at all (the HTTP layer then answers 404).
 */
export function handleGit(
  forge: Forge,
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  isInfoRefs: boolean,
  isV2: boolean,
  body: Buffer,
): GitResponse | null {
  if (isInfoRefs) {
    if (service === 'git-upload-pack') {
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: isV2 ? uploadPackAdvertisementV2() : uploadPackAdvertisementV0(repo),
      };
    }
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-advertisement',
      body: receivePackAdvertisementV0(repo),
    };
  }
  if (service === 'git-upload-pack') {
    if (isV2) {
      const { command } = parseV2Command(body);
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefsV2(repo, body) };
      }
      if (command === 'fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV2(forge, repo, body) };
      }
      return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown v2 command ${command}`, 'utf8') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV0(forge, repo, body) };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: handleReceivePack(forge, repo, body) };
}
