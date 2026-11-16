import type { IncomingMessage, ServerResponse } from 'node:http';
import { globalStore } from './store.ts';
import { VIEWER_LOGIN } from './viewer.ts';
import { createRepo, createIssue, closeIssue, createPullRequest, mergePullRequest, addComment, changedFiles } from './service.ts';

export function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (url.pathname !== '/mcp') {
    return false;
  }

  const handleAsync = async () => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' }, id: null }));
      return;
    }

    // Auth check
    const authHeader = req.headers['authorization'];
    const expectedToken = process.env.MAKEFUN_SHOP_TOKEN || '';
    if (expectedToken !== '') {
      if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7).trim() !== expectedToken) {
        res.statusCode = 401;
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Requires authentication' }, id: null }));
        return;
      }
    }

    let rawBody = '';
    for await (const chunk of req) {
      rawBody += chunk;
    }

    if (!rawBody.trim()) {
      res.statusCode = 400;
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }

    let bodyData: any;
    try {
      bodyData = JSON.parse(rawBody);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }

    const id = bodyData.id !== undefined ? bodyData.id : null;
    const method = bodyData.method;
    const params = bodyData.params || {};

    if (!method) {
      res.statusCode = 400;
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id }));
      return;
    }

    // Notification check (no id)
    const isNotification = id === null && (method === 'notifications/initialized' || method.startsWith('notifications/'));
    if (isNotification) {
      res.statusCode = 202;
      res.end();
      return;
    }

    let result: any = null;
    let error: any = null;

    switch (method) {
      case 'server/discover':
        result = {
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
          capabilities: { tools: {} },
          serverInfo: { name: 'forge', version: '1.0.0' },
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' }
          }
        };
        break;

      case 'initialize':
        result = {
          protocolVersion: params.protocolVersion || '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'forge', version: '1.0.0' }
        };
        break;

      case 'ping':
        result = {};
        break;

      case 'tools/list':
        result = {
          tools: getToolsList()
        };
        break;

      case 'tools/call':
        try {
          const toolName = params.name;
          const args = params.arguments || {};
          const validTools = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request', 'get_issue', 'list_pull_requests'];
          if (!validTools.includes(toolName)) {
            error = { code: -32602, message: `Unknown tool: ${toolName}` };
            break;
          }
          result = executeTool(toolName, args);
        } catch (err: any) {
          result = {
            content: [{ type: 'text', text: err.message || 'Tool execution failed' }],
            isError: true
          };
        }
        break;

      default:
        error = { code: -32601, message: `Method not found: ${method}` };
        break;
    }

    res.statusCode = 200;
    if (error) {
      res.end(JSON.stringify({ jsonrpc: '2.0', error, id }));
    } else {
      res.end(JSON.stringify({ jsonrpc: '2.0', result, id }));
    }
  };

  handleAsync().catch(err => {
    res.statusCode = 500;
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: err.message || 'Internal error' }, id: null }));
  });

  return true;
}

function getToolsList() {
  return [
    {
      name: 'create_repo',
      description: 'Create a new repository under the viewer',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          private: { type: 'boolean' },
          owner: { type: 'string' }
        },
        required: ['name']
      }
    },
    {
      name: 'get_repo',
      description: 'Get repository details',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          full_name: { type: 'string' }
        },
        required: []
      }
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          full_name: { type: 'string' }
        },
        required: ['title']
      }
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          state: { type: 'string' },
          full_name: { type: 'string' }
        },
        required: []
      }
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          title: { type: 'string' },
          head: { type: 'string' },
          base: { type: 'string' },
          body: { type: 'string' },
          full_name: { type: 'string' }
        },
        required: ['title', 'head', 'base']
      }
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          pull_number: { type: 'number' },
          full_name: { type: 'string' }
        },
        required: ['pull_number']
      }
    },
    {
      name: 'get_issue',
      description: 'Get issue details',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          issue_number: { type: 'number' },
          full_name: { type: 'string' }
        },
        required: ['issue_number']
      }
    },
    {
      name: 'list_pull_requests',
      description: 'List pull requests',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          state: { type: 'string' },
          full_name: { type: 'string' }
        },
        required: []
      }
    }
  ];
}

function resolveRepoFullName(args: any): string {
  if (args.full_name && typeof args.full_name === 'string') {
    return args.full_name;
  }
  const owner = args.owner || VIEWER_LOGIN;
  const repo = args.repo;
  if (!repo) {
    // find any repo if not specified
    for (const r of globalStore.repos.values()) {
      return r.full_name;
    }
    throw new Error('Missing required argument: repo');
  }
  return `${owner}/${repo}`;
}

function executeTool(name: string, args: any): any {
  if (!name) throw new Error('Tool name required');

  let structuredContent: any = {};

  switch (name) {
    case 'create_repo': {
      if (!args.name) {
        return { content: [{ type: 'text', text: 'Missing required argument: name' }], isError: true };
      }
      const owner = args.owner || VIEWER_LOGIN;
      const repo = createRepo(args.name, { private: args.private, description: args.description }, owner);
      structuredContent = repo;
      break;
    }

    case 'get_repo': {
      const fullName = resolveRepoFullName(args);
      const repo = globalStore.repos.get(fullName);
      if (!repo) throw new Error(`Repository not found: ${fullName}`);
      structuredContent = repo;
      break;
    }

    case 'create_issue': {
      if (!args.title) {
        return { content: [{ type: 'text', text: 'Missing required argument: title' }], isError: true };
      }
      const fullName = resolveRepoFullName(args);
      const issue = createIssue(fullName, args.title, args.body);
      structuredContent = issue;
      break;
    }

    case 'list_issues': {
      const fullName = resolveRepoFullName(args);
      const issuesMap = globalStore.getIssues(fullName);
      const state = args.state || 'open';
      const list: any[] = [];
      for (const i of issuesMap.values()) {
        if (state === 'all' || i.state === state) {
          list.push(i);
        }
      }
      structuredContent = list;
      break;
    }

    case 'create_pull_request': {
      if (!args.title || !args.head || !args.base) {
        return { content: [{ type: 'text', text: 'Missing required argument: title, head, or base' }], isError: true };
      }
      const fullName = resolveRepoFullName(args);
      const pr = createPullRequest(fullName, args.title, args.body, args.head, args.base);
      structuredContent = pr;
      break;
    }

    case 'merge_pull_request': {
      if (args.pull_number === undefined) {
        return { content: [{ type: 'text', text: 'Missing required argument: pull_number' }], isError: true };
      }
      const fullName = resolveRepoFullName(args);
      const res = mergePullRequest(fullName, args.pull_number);
      structuredContent = res;
      break;
    }

    case 'get_issue': {
      if (args.issue_number === undefined) {
        return { content: [{ type: 'text', text: 'Missing required argument: issue_number' }], isError: true };
      }
      const fullName = resolveRepoFullName(args);
      const issuesMap = globalStore.getIssues(fullName);
      const issue = issuesMap.get(args.issue_number);
      if (!issue) throw new Error(`Issue not found: ${args.issue_number}`);
      structuredContent = issue;
      break;
    }

    case 'list_pull_requests': {
      const fullName = resolveRepoFullName(args);
      const pullsMap = globalStore.getPulls(fullName);
      const state = args.state || 'open';
      const list: any[] = [];
      for (const p of pullsMap.values()) {
        if (state === 'all' || p.state === state) {
          list.push(p);
        }
      }
      structuredContent = list;
      break;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: false
  };
}
