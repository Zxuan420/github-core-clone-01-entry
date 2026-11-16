import type { IncomingMessage, ServerResponse } from 'node:http';
import { globalStore } from './store.ts';
import * as zlib from 'node:zlib';
import { createHash } from 'node:crypto';

// --- Pkt-line Framing & Sideband ---

export function encodePktLine(str: string): Buffer {
  const buf = Buffer.from(str, 'utf8');
  const len = buf.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'utf8'), buf]);
}

export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'utf8');
}

export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'utf8');
}

export function encodeResponseEnd(): Buffer {
  return Buffer.from('0002', 'utf8');
}

export function encodeSideband(band: number, data: Buffer): Buffer {
  // max payload per chunk is 65515 (65535 - 4 len - 1 band)
  const maxChunk = 65500;
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + maxChunk);
    offset += maxChunk;
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    const len = payload.length + 4;
    const hex = len.toString(16).padStart(4, '0');
    chunks.push(Buffer.concat([Buffer.from(hex, 'utf8'), payload]));
  }
  return Buffer.concat(chunks);
}

// --- Request Body Reader ---

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// --- Packfile Parsing & Delta Resolution ---

export function parseAndStorePackfile(fullName: string, packBuffer: Buffer): void {
  if (packBuffer.length < 32) return;
  const sig = packBuffer.subarray(0, 4).toString('ascii');
  if (sig !== 'PACK') throw new Error('Invalid pack signature');
  const version = packBuffer.readUInt32BE(4);
  const numObjects = packBuffer.readUInt32BE(8);

  let offset = 12;
  const objectsByOffset = new Map<number, { type: string; content: Buffer; sha: string }>();
  const pendingDeltas: Array<{
    objOffset: number;
    type: 'ref-delta' | 'ofs-delta';
    baseSha?: string;
    baseOffset?: number;
    deltaContent: Buffer;
  }> = [];

  for (let i = 0; i < numObjects; i++) {
    const objOffset = offset;
    if (offset >= packBuffer.length - 20) break;

    let b = packBuffer[offset++]!;
    let typeNum = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;

    while (b & 0x80) {
      if (offset >= packBuffer.length) break;
      b = packBuffer[offset++]!;
      size += (b & 0x7f) << shift;
      shift += 7;
    }

    let baseSha: string | undefined;
    let baseOffset: number | undefined;

    if (typeNum === 6) {
      // OBJ_OFS_DELTA
      let c = packBuffer[offset++]!;
      let val = c & 0x7f;
      while (c & 0x80) {
        if (offset >= packBuffer.length) break;
        c = packBuffer[offset++]!;
        val = ((val + 1) << 7) + (c & 0x7f);
      }
      baseOffset = objOffset - val;
    } else if (typeNum === 7) {
      // OBJ_REF_DELTA
      if (offset + 20 > packBuffer.length) break;
      baseSha = packBuffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }

    // Find zlib compressed data length by trial and error up to trailer
    let inflated: Buffer = Buffer.alloc(0);
    let consumed = 0;
    const maxLen = packBuffer.length - 20 - offset;
    for (let len = 1; len <= maxLen; len++) {
      try {
        inflated = zlib.inflateSync(packBuffer.subarray(offset, offset + len));
        consumed = len;
        break;
      } catch {
        // continue
      }
    }
    if (consumed === 0) {
      try {
        inflated = zlib.inflateSync(packBuffer.subarray(offset, packBuffer.length - 20));
        consumed = packBuffer.length - 20 - offset;
      } catch {
        break;
      }
    }
    offset += consumed;

    let typeStr = '';
    if (typeNum === 1) typeStr = 'commit';
    else if (typeNum === 2) typeStr = 'tree';
    else if (typeNum === 3) typeStr = 'blob';
    else if (typeNum === 4) typeStr = 'tag';

    if (typeStr) {
      const sha = globalStore.writeRawObject(fullName, typeStr as any, inflated);
      objectsByOffset.set(objOffset, { type: typeStr, content: inflated, sha });
    } else if (typeNum === 6 || typeNum === 7) {
      pendingDeltas.push({
        objOffset,
        type: typeNum === 6 ? 'ofs-delta' : 'ref-delta',
        baseSha,
        baseOffset,
        deltaContent: inflated,
      });
    }
  }

  // Resolve pending deltas (iterate until all resolved or no progress)
  let unresolved = [...pendingDeltas];
  let progress = true;
  while (unresolved.length > 0 && progress) {
    progress = false;
    const nextUnresolved: typeof unresolved = [];
    for (const delta of unresolved) {
      let baseObj: { type: string; content: Buffer; sha: string } | undefined;
      if (delta.type === 'ref-delta' && delta.baseSha) {
        const raw = globalStore.readObject(fullName, delta.baseSha);
        if (raw) baseObj = { type: raw.type, content: raw.content, sha: delta.baseSha };
      } else if (delta.type === 'ofs-delta' && delta.baseOffset !== undefined) {
        baseObj = objectsByOffset.get(delta.baseOffset);
      }

      if (baseObj) {
        const targetContent = applyDelta(baseObj.content, delta.deltaContent);
        // Determine object type from base or delta instruction (git deltas inherit base object type)
        const targetType = baseObj.type as any;
        const sha = globalStore.writeRawObject(fullName, targetType, targetContent);
        objectsByOffset.set(delta.objOffset, { type: targetType, content: targetContent, sha });
        progress = true;
      } else {
        nextUnresolved.push(delta);
      }
    }
    unresolved = nextUnresolved;
  }
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  // Read source size
  let { value: srcSize, newOffset: o1 } = readVarint(delta, offset);
  offset = o1;
  // Read target size
  let { value: targetSize, newOffset: o2 } = readVarint(delta, offset);
  offset = o2;

  const target = Buffer.alloc(targetSize);
  let targetOffset = 0;

  while (offset < delta.length) {
    const cmd = delta[offset++]!;
    if (cmd & 0x80) {
      // Copy instruction
      let cpOff = 0;
      let cpSize = 0;
      if (cmd & 0x01) cpOff |= delta[offset++]!;
      if (cmd & 0x02) cpOff |= delta[offset++]! << 8;
      if (cmd & 0x04) cpOff |= delta[offset++]! << 16;
      if (cmd & 0x08) cpOff |= delta[offset++]! << 24;

      if (cmd & 0x10) cpSize |= delta[offset++]!;
      if (cmd & 0x20) cpSize |= delta[offset++]! << 8;
      if (cmd & 0x40) cpSize |= delta[offset++]! << 16;
      if (cpSize === 0) cpSize = 0x10000;

      const chunk = base.subarray(cpOff, cpOff + cpSize);
      chunk.copy(target, targetOffset);
      targetOffset += chunk.length;
    } else {
      // Insert instruction
      const len = cmd & 0x7f;
      const chunk = delta.subarray(offset, offset + len);
      offset += len;
      chunk.copy(target, targetOffset);
      targetOffset += chunk.length;
    }
  }
  return target;
}

function readVarint(buf: Buffer, offset: number): { value: number; newOffset: number } {
  let value = 0;
  let shift = 0;
  let b: number;
  do {
    b = buf[offset++]!;
    value |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return { value, newOffset: offset };
}

// --- Packfile Generator (Upload-Pack) ---

export function generatePackfile(fullName: string, wantShas: string[]): Buffer {
  // Collect all reachable objects starting from wantShas
  const visited = new Set<string>();
  const queue = [...wantShas];

  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (visited.has(sha)) continue;
    visited.add(sha);

    const obj = globalStore.readObject(fullName, sha);
    if (!obj) continue;

    if (obj.type === 'commit') {
      const text = obj.content.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.startsWith('tree ')) {
          queue.push(line.slice(5).trim());
        } else if (line.startsWith('parent ')) {
          queue.push(line.slice(7).trim());
        }
      }
    } else if (obj.type === 'tree') {
      const entries = globalStore.parseTree(fullName, sha);
      for (const entry of entries) {
        queue.push(entry.sha);
      }
    }
  }

  const objects: Array<{ type: string; content: Buffer }> = [];
  for (const sha of visited) {
    const obj = globalStore.readObject(fullName, sha);
    if (obj) {
      objects.push({ type: obj.type, content: obj.content });
    }
  }

  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4); // version 2
  header.writeUInt32BE(objects.length, 8);

  const parts: Buffer[] = [header];
  for (const obj of objects) {
    let typeNum = 1;
    if (obj.type === 'commit') typeNum = 1;
    else if (obj.type === 'tree') typeNum = 2;
    else if (obj.type === 'blob') typeNum = 3;
    else if (obj.type === 'tag') typeNum = 4;

    // Encode type and size
    const headerBytes: number[] = [];
    let size = obj.content.length;
    headerBytes.push(((typeNum & 7) << 4) | (size & 15));
    size >>= 4;
    while (size > 0) {
      headerBytes[headerBytes.length - 1]! |= 0x80;
      headerBytes.push(size & 0x7f);
      size >>= 7;
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(zlib.deflateSync(obj.content));
  }

  const packedWithoutChecksum = Buffer.concat(parts);
  const checksum = createHash('sha1').update(packedWithoutChecksum).digest();
  return Buffer.concat([packedWithoutChecksum, checksum]);
}

// --- Handlers ---

export function handleGit(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const pathname = url.pathname;
  console.log('[git] request:', req.method, pathname);
  // Match /{owner}/{repo}.git/...
  const match = pathname.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
  if (!match) return false;

  const owner = match[1]!;
  const repoName = match[2]!;
  const gitSubPath = match[3] || '/';
  const fullName = `${owner}/${repoName}`;

  // Auth check
  const authHeader = req.headers['authorization'];
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN || '';
  if (expectedToken !== '') {
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7).trim() !== expectedToken) {
      res.statusCode = 401;
      res.end('Requires authentication');
      return true;
    }
  }

  if (req.headers['expect'] === '100-continue') {
    res.writeContinue();
  }

  // Repo existence check
  const repo = globalStore.repos.get(fullName);
  if (!repo) {
    res.statusCode = 404;
    res.end('Repository not found');
    return true;
  }

  const method = req.method || 'GET';

  // Async handler wrapper
  (async () => {
    // 1. GET /info/refs
    if (gitSubPath === '/info/refs' && method === 'GET') {
      const service = url.searchParams.get('service');
      const protocol = req.headers['git-protocol'] || '';

      if (service === 'git-upload-pack') {
        if (protocol.includes('version=2') || url.searchParams.get('version') === '2') {
          res.setHeader('Content-Type', 'application/x-git-upload-pack-advertisement');
          res.statusCode = 200;
          const lines = [
            encodePktLine('version 2\n'),
            encodePktLine('ls-refs\n'),
            encodePktLine('fetch=shallow wait-for-done symref object-info\n'),
            encodePktLine('server-option\n'),
            encodeFlush(),
          ];
          res.end(Buffer.concat(lines));
          return;
        } else {
          res.setHeader('Content-Type', 'application/x-git-upload-pack-advertisement');
          res.statusCode = 200;
          const lines: Buffer[] = [];
          lines.push(encodePktLine('# service=git-upload-pack\n'));
          lines.push(encodeFlush());

          const refs = globalStore.getRefs(fullName);
          const headSha = refs.get('refs/heads/main') || refs.get('HEAD') || '0'.repeat(40);
          
          let first = true;
          const caps = 'side-band-64k agent=git/2.x symref=HEAD:refs/heads/main';
          
          if (refs.size === 0) {
            lines.push(encodePktLine(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`));
          } else {
            lines.push(encodePktLine(`${headSha} HEAD\0${caps}\n`));
            first = false;
            for (const [refName, sha] of refs.entries()) {
              if (refName === 'HEAD') continue;
              lines.push(encodePktLine(`${sha} ${refName}\n`));
            }
          }

          lines.push(encodeFlush());
          res.end(Buffer.concat(lines));
          return;
        }
      }

      if (service === 'git-receive-pack') {
        res.setHeader('Content-Type', 'application/x-git-receive-pack-advertisement');
        res.statusCode = 200;
        const lines: Buffer[] = [];
        lines.push(encodePktLine('# service=git-receive-pack\n'));
        lines.push(encodeFlush());

        const refs = globalStore.getRefs(fullName);
        let first = true;
        const caps = 'report-status delete-refs agent=git/2.x';

        for (const [refName, sha] of refs.entries()) {
          if (first) {
            lines.push(encodePktLine(`${sha} ${refName}\0${caps}\n`));
            first = false;
          } else {
            lines.push(encodePktLine(`${sha} ${refName}\n`));
          }
        }

        if (first) {
          lines.push(encodePktLine(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`));
        }

        lines.push(encodeFlush());
        res.end(Buffer.concat(lines));
        return;
      }

      // Default info/refs (dumb HTTP or generic)
      res.setHeader('Content-Type', 'text/plain');
      res.statusCode = 200;
      res.end('');
      return;
    }

    // 2. POST /git-upload-pack
    if (gitSubPath === '/git-upload-pack' && method === 'POST') {
      const protocol = req.headers['git-protocol'] || '';
      const bodyBuf = await readBody(req);

      if (protocol.includes('version=2')) {
        res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
        res.statusCode = 200;

        // Parse protocol v2 requests (ls-refs, fetch)
        // Read pkt-lines from bodyBuf
        let offset = 0;
        const responseBuffers: Buffer[] = [];
        let wantShas: string[] = [];

        while (offset + 4 <= bodyBuf.length) {
          const lenHex = bodyBuf.subarray(offset, offset + 4).toString('utf8');
          if (lenHex === '0000') {
            offset += 4;
            continue;
          }
          const len = parseInt(lenHex, 16);
          if (isNaN(len) || len === 0) break;
          const pkt = bodyBuf.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
          offset += len;

          if (pkt === 'command=ls-refs') {
            // Read args until flush
            while (offset + 4 <= bodyBuf.length) {
              const argLenHex = bodyBuf.subarray(offset, offset + 4).toString('utf8');
              if (argLenHex === '0000') {
                offset += 4;
                break;
              }
              const argLen = parseInt(argLenHex, 16);
              if (isNaN(argLen) || argLen === 0) break;
              const argPkt = bodyBuf.subarray(offset + 4, offset + argLen).toString('utf8').replace(/\n$/, '');
              offset += argLen;

              if (argPkt.startsWith('ref-prefix')) {
                // handle ref prefix filtering if needed
              }
            }

            // Output ls-refs result
            const refs = globalStore.getRefs(fullName);
            const headSha = refs.get('refs/heads/main');
            if (headSha) {
              responseBuffers.push(encodePktLine(`${headSha} refs/heads/main symref-target:refs/heads/main\n`));
            }
            for (const [refName, sha] of refs.entries()) {
              if (refName === 'refs/heads/main') continue;
              responseBuffers.push(encodePktLine(`${sha} ${refName}\n`));
            }
            responseBuffers.push(encodeFlush());
          } else if (pkt === 'command=fetch') {
            // Read fetch args (want, have, done, etc.)
            while (offset + 4 <= bodyBuf.length) {
              const argLenHex = bodyBuf.subarray(offset, offset + 4).toString('utf8');
              if (argLenHex === '0000') {
                offset += 4;
                break;
              }
              const argLen = parseInt(argLenHex, 16);
              if (isNaN(argLen) || argLen === 0) break;
              const argPkt = bodyBuf.subarray(offset + 4, offset + argLen).toString('utf8').replace(/\n$/, '');
              offset += argLen;

              if (argPkt.startsWith('want ')) {
                wantShas.push(argPkt.slice(5).trim());
              }
            }

            // Generate packfile for wants
            responseBuffers.push(encodePktLine('packfile\n'));
            const packfile = generatePackfile(fullName, wantShas);
            responseBuffers.push(encodeSideband(1, packfile));
            responseBuffers.push(encodeFlush());
            // omit encodeResponseEnd() if git client expects just flush or packfile end
          }
        }

        res.end(Buffer.concat(responseBuffers));
        return;
      } else {
        // v0 upload-pack
        res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
        res.statusCode = 200;

        let offset = 0;
        const wantShas: string[] = [];

        while (offset + 4 <= bodyBuf.length) {
          const lenHex = bodyBuf.subarray(offset, offset + 4).toString('utf8');
          if (lenHex === '0000') {
            offset += 4;
            continue;
          }
          const len = parseInt(lenHex, 16);
          if (isNaN(len) || len === 0) break;
          const pkt = bodyBuf.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
          offset += len;

          if (pkt.startsWith('want ')) {
            wantShas.push(pkt.slice(5).trim());
          } else if (pkt === 'done') {
            break;
          }
        }

        const responseBuffers: Buffer[] = [];
        responseBuffers.push(encodePktLine('NAK\n'));
        const packfile = generatePackfile(fullName, wantShas);
        responseBuffers.push(encodeSideband(1, packfile));
        responseBuffers.push(encodeFlush());

        res.end(Buffer.concat(responseBuffers));
        return;
      }
    }

    // 3. POST /git-receive-pack
    if (gitSubPath === '/git-receive-pack' && method === 'POST') {
      res.setHeader('Content-Type', 'application/x-git-receive-pack-result');
      res.statusCode = 200;

      const bodyBuf = await readBody(req);
      let offset = 0;
      const commands: Array<{ oldOoid: string; newOid: string; refName: string }> = [];

      while (offset + 4 <= bodyBuf.length) {
        const lenHex = bodyBuf.subarray(offset, offset + 4).toString('utf8');
        if (lenHex === '0000') {
          offset += 4;
          break;
        }
        const len = parseInt(lenHex, 16);
        if (isNaN(len) || len === 0) break;
        const pkt = bodyBuf.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
        offset += len;

        let line = pkt;
        if (commands.length === 0) {
          const nullIdx = line.indexOf('\0');
          if (nullIdx !== -1) {
            line = line.slice(0, nullIdx);
          }
        }
        const parts = line.split(' ');
        if (parts.length >= 3) {
          commands.push({
            oldOoid: parts[0]!,
            newOid: parts[1]!,
            refName: parts[2]!,
          });
        }
      }

      const packfileBuffer = bodyBuf.subarray(offset);
      if (packfileBuffer.length > 0) {
        try {
          parseAndStorePackfile(fullName, packfileBuffer);
        } catch (err) {
          console.error('[git] Error parsing packfile:', err);
        }
      }

      const refs = globalStore.getRefs(fullName);
      const reportLines: string[] = ['unpack ok\n'];

      for (const cmd of commands) {
        const { oldOoid, newOid, refName } = cmd;
        const zeroOid = '0'.repeat(40);
        const currentSha = refs.get(refName) || zeroOid;

        if (newOid === zeroOid) {
          refs.delete(refName);
          reportLines.push(`ok ${refName}\n`);
          continue;
        }

        if (oldOoid === zeroOid || currentSha === oldOoid || currentSha === zeroOid) {
          refs.set(refName, newOid);
          reportLines.push(`ok ${refName}\n`);
          if (refName === 'refs/heads/main') {
            repo.pushed_at = new Date().toISOString();
          }
        } else {
          reportLines.push(`ng ${refName} non-fast-forward\n`);
        }
      }

      const reportBuffers: Buffer[] = [];
      for (const line of reportLines) {
        reportBuffers.push(encodePktLine(line));
      }
      reportBuffers.push(encodeFlush());
      res.end(Buffer.concat(reportBuffers));
      return;
    }

    res.statusCode = 404;
    res.end('Not Found');
  })().catch(err => {
    res.statusCode = 500;
    res.end(err.message || 'Internal Server Error');
  });

  return true;
}
