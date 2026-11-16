import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { randomBytes } from 'node:crypto';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const requestId = randomBytes(8).toString('hex');
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'X-GitHub-Request-Id': requestId,
    ...headers,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://entry');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (process.env.FORGE_DEBUG) {
      console.log('[app] incoming:', method, path);
    }

    // Health check
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // REST v3 API
    if (path.startsWith('/api/v3')) {
      const handled = handleRest(req, res, url);
      if (handled) return;
    }

    // GraphQL API
    if (path === '/api/graphql') {
      const handled = handleGraphql(req, res, url);
      if (handled) return;
    }

    // MCP endpoint
    if (path === '/mcp') {
      const handled = handleMcp(req, res, url);
      if (handled) return;
    }

    // Git smart HTTP
    if (path.includes('.git/')) {
      const handled = handleGit(req, res, url);
      if (handled) return;
    }

    // Default 404
    sendJson(res, 404, { message: 'Not Found' });
  });
}
