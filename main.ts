// The forge's entry point: one process, one HTTP server, four surfaces.
// The suite gives it MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN; the entry binds
// an ephemeral port, registers it, serves git smart HTTP, REST v3, GraphQL v4
// and MCP from the one store, and exits 0 when the env's /done answers true.
// Without an env URL (a local run) it just serves on an ephemeral port.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { VIEWER } from './scenario.ts';
import { handleGit } from './git.ts';
import { handleRest, type RestRequest, type RestResponse } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
void SHOP_TOKEN;

const forge = new Forge(VIEWER.login);

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  response.end(text);
}

function sendBuffer(response: ServerResponse, status: number, contentType: string, body: Buffer): void {
  response.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  response.end(body);
}

function sendRest(response: ServerResponse, result: RestResponse): void {
  const headers = { ...(result.headers ?? {}) };
  if (result.body === null || result.body === undefined) {
    response.writeHead(result.status, { 'content-length': 0, ...headers });
    response.end();
    return;
  }
  const text = JSON.stringify(result.body);
  response.writeHead(result.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  response.end(text);
}

async function register(port: number): Promise<void> {
  const response = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!response.ok) throw new Error(`register failed with HTTP ${response.status}`);
}

/** Long-poll /done with backoff (250ms → 2000ms), returning when it answers true. */
async function waitDone(): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(`${ENV_URL}/done`);
      if (response.ok) {
        const data = (await response.json()) as { done?: unknown };
        if (data.done === true) return;
      }
    } catch {
      // The env is briefly unreachable: keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 2000);
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const body = await readBody(request);
    const host = request.headers.host ?? '127.0.0.1';
    const url = new URL(request.url ?? '/', `http://${host}`);
    const headers = new Map<string, string>();
    for (const [key, value] of Object.entries(request.headers)) {
      headers.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : (value ?? ''));
    }
    const path = decodeURIComponent(url.pathname);
    const method = request.method ?? 'GET';

    if (path === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    const gitMatch = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const owner = gitMatch[1] as string;
      // Git clients address a repo as <name>.git over smart HTTP; the store
      // holds it under the bare name, so drop a trailing .git here.
      const repoName = (gitMatch[2] as string).replace(/\.git$/, '');
      const tail = gitMatch[3] as string;
      const repo = owner === forge.viewerLogin ? forge.getRepo(repoName) : undefined;
      if (!repo) {
        sendJson(response, 404, { message: 'Not Found' });
        return;
      }
      if (tail === 'info/refs') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(response, 400, { message: 'Missing service parameter' });
          return;
        }
        const isV2 = headers.get('git-protocol') === 'version=2';
        const result = handleGit(forge, repo, service, true, isV2, Buffer.alloc(0));
        if (result === null) sendJson(response, 404, { message: 'Not Found' });
        else sendBuffer(response, result.status, result.contentType, result.body);
        return;
      }
      const service = tail === 'git-upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
      const isV2 = headers.get('git-protocol') === 'version=2';
      const result = handleGit(forge, repo, service, false, isV2, body);
      if (result === null) sendJson(response, 404, { message: 'Not Found' });
      else sendBuffer(response, result.status, result.contentType, result.body);
      return;
    }

    if (path.startsWith('/api/v3')) {
      const restRequest: RestRequest = {
        method,
        path,
        query: url.searchParams,
        headers,
        bodyText: body.toString('utf8'),
        url: `http://${host}${request.url ?? '/'}`,
      };
      const result = handleRest(forge, restRequest);
      if (result === null) sendJson(response, 404, { message: 'Not Found' });
      else sendRest(response, result);
      return;
    }

    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(response, 404, { message: 'Not Found' });
        return;
      }
      const result = handleGraphQL(forge, { headers, bodyText: body.toString('utf8') });
      sendJson(response, result.status, result.body);
      return;
    }

    if (path === '/mcp') {
      if (method === 'DELETE') {
        response.writeHead(204, { 'content-length': 0 });
        response.end();
        return;
      }
      if (method !== 'POST') {
        sendJson(response, 404, { message: 'Not Found' });
        return;
      }
      const result = handleMcp(forge, { headers, bodyText: body.toString('utf8') });
      if (result.status === 202) {
        response.writeHead(202, { 'content-length': 0 });
        response.end();
        return;
      }
      sendJson(response, result.status, result.body);
      return;
    }

    sendJson(response, 404, { message: 'Not Found' });
  } catch (error) {
    // A malformed request must never kill the server.
    try {
      sendJson(response, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
    } catch {
      // The socket is already gone.
    }
  }
}

const server = createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (ENV_URL === '') {
    console.log(`forge listening on http://127.0.0.1:${port} (no MAKEFUN_ENV_URL; standalone mode)`);
    return;
  }
  void (async () => {
    try {
      await register(port);
      await waitDone();
      server.close(() => process.exit(0));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  })();
});
