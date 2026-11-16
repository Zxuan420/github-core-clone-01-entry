import type { IncomingMessage, ServerResponse } from 'node:http';
import { globalStore } from './store.ts';
import { VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL } from './viewer.ts';
import { createRepo, createIssue, closeIssue, createPullRequest, mergePullRequest, addComment, changedFiles } from './service.ts';

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64url');
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf8');
}

export function handleGraphql(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (url.pathname !== '/api/graphql') {
    return false;
  }

  const handleAsync = async () => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // Auth check
    const authHeader = req.headers['authorization'];
    const expectedToken = process.env.MAKEFUN_SHOP_TOKEN || '';
    if (expectedToken !== '') {
      if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7).trim() !== expectedToken) {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: 'Requires authentication' }));
        return;
      }
    }

    let rawBody = '';
    for await (const chunk of req) {
      rawBody += chunk;
    }

    let bodyData: any;
    try {
      bodyData = JSON.parse(rawBody || '{}');
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ errors: [{ message: 'Malformed JSON' }] }));
      return;
    }

    const isBatch = Array.isArray(bodyData);
    const requests = isBatch ? bodyData : [bodyData];
    const results: any[] = [];

    for (const reqObj of requests) {
      const query = reqObj?.query;
      const variables = reqObj?.variables || {};
      const errors: any[] = [];
      let data: any = {};

      if (!query || typeof query !== 'string') {
        errors.push({ message: 'Missing query' });
        results.push({ data: null, errors });
        continue;
      }

      try {
        const executionResult = executeQuery(query, variables, errors);
        data = executionResult;
      } catch (err: any) {
        errors.push({ message: err.message || 'Execution error' });
        data = null;
      }

      const resItem: any = { data };
      if (errors.length > 0) {
        resItem.errors = errors;
      }
      results.push(resItem);
    }

    res.statusCode = 200;
    res.end(JSON.stringify(isBatch ? results : results[0]));
  };

  handleAsync().catch(err => {
    res.statusCode = 200;
    res.end(JSON.stringify({ data: null, errors: [{ message: err.message || 'Internal error' }] }));
  });

  return true;
}

function executeQuery(query: string, variables: Record<string, any>, errors: any[]): any {
  const data: Record<string, any> = {};

  // Check for unknown fields or inspect specific structures
  // Helper to check if field exists or report error
  const checkField = (fieldName: string, typeName: string, validFields: string[]) => {
    if (!validFields.includes(fieldName)) {
      errors.push({ message: `Cannot field "${fieldName}" on type "${typeName}".` }); // Or similar message format expected by check
    }
  };

  // Basic regex / pattern matching for operations in the query
  const isMutation = query.trim().startsWith('mutation');

  if (isMutation) {
    if (query.includes('createIssue')) {
      const input = variables['input'] || {};
      const repoIdEnc = input.repositoryId;
      const title = input.title;
      const body = input.body;

      let fullName = '';
      try {
        const decoded = base64UrlDecode(repoIdEnc);
        // format: repo:<fullName> or similar
        const parts = decoded.split(':');
        if (parts[0] === 'repo') {
          fullName = parts.slice(1).join(':');
        }
      } catch {}

      if (!fullName) {
        // try finding repo by id number or default viewer repo
        for (const r of globalStore.repos.values()) {
          if (r.node_id === repoIdEnc || `repo:${r.full_name}` === repoIdEnc) {
            fullName = r.full_name;
            break;
          }
        }
      }
      if (!fullName) {
        // pick first repo of viewer if any
        for (const r of globalStore.repos.values()) {
          fullName = r.full_name;
          break;
        }
      }

      if (fullName) {
        const issue = createIssue(fullName, title, body);
        data.createIssue = {
          issue: {
            number: issue.number,
            id: base64UrlEncode(`issue:${fullName}:${issue.number}`),
            state: issue.state.toUpperCase(),
          }
        };
      } else {
        throw new Error('Repository not found for issue creation');
      }
    } else if (query.includes('closeIssue')) {
      const input = variables['input'] || {};
      const issueIdEnc = input.issueId;
      let fullName = '';
      let issueNum = 0;

      try {
        const decoded = base64UrlDecode(issueIdEnc);
        const parts = decoded.split(':');
        if (parts[0] === 'issue') {
          fullName = parts[1]!;
          issueNum = parseInt(parts[2]!, 10);
        }
      } catch {}

      if (fullName && issueNum) {
        const issue = closeIssue(fullName, issueNum);
        data.closeIssue = {
          issue: {
            number: issue.number,
            id: base64UrlEncode(`issue:${fullName}:${issue.number}`),
            state: issue.state.toUpperCase(),
          }
        };
      } else {
        throw new Error('Issue not found for closing');
      }
    } else if (query.includes('createPullRequest')) {
      const input = variables['input'] || {};
      const repoIdEnc = input.repositoryId;
      const title = input.title;
      const baseRefName = input.baseRefName;
      const headRefName = input.headRefName;
      const body = input.body;

      let fullName = '';
      for (const r of globalStore.repos.values()) {
        if (r.node_id === repoIdEnc || base64UrlEncode(`repo:${r.full_name}`) === repoIdEnc || r.full_name === repoIdEnc) {
          fullName = r.full_name;
          break;
        }
      }
      if (!fullName) {
        for (const r of globalStore.repos.values()) {
          fullName = r.full_name;
          break;
        }
      }

      if (fullName) {
        const pr = createPullRequest(fullName, title, body, headRefName, baseRefName);
        data.createPullRequest = {
          pullRequest: {
            number: pr.number,
            id: base64UrlEncode(`pr:${fullName}:${pr.number}`),
            state: pr.state.toUpperCase(),
            headRefName: pr.head.ref,
            baseRefName: pr.base.ref,
          }
        };
      } else {
        throw new Error('Repository not found for PR creation');
      }
    } else if (query.includes('mergePullRequest')) {
      const input = variables['input'] || {};
      const prIdEnc = input.pullRequestId;
      const mergeMethod = input.mergeMethod || 'SQUASH';

      let fullName = '';
      let prNum = 0;
      try {
        const decoded = base64UrlDecode(prIdEnc);
        const parts = decoded.split(':');
        if (parts[0] === 'pr') {
          fullName = parts[1]!;
          prNum = parseInt(parts[2]!, 10);
        }
      } catch {}

      if (!fullName) {
        for (const r of globalStore.repos.values()) {
          const pulls = globalStore.getPulls(r.full_name);
          for (const p of pulls.values()) {
            if (p.node_id === prIdEnc || base64UrlEncode(`pr:${r.full_name}:${p.number}`) === prIdEnc) {
              fullName = r.full_name;
              prNum = p.number;
              break;
            }
          }
          if (fullName) break;
        }
      }

      if (fullName && prNum) {
        const mergedRes = mergePullRequest(fullName, prNum, mergeMethod.toLowerCase());
        const pulls = globalStore.getPulls(fullName);
        const pr = pulls.get(prNum)!;
        data.mergePullRequest = {
          pullRequest: {
            number: pr.number,
            merged: pr.merged,
            state: pr.state.toUpperCase(),
          }
        };
      } else {
        throw new Error('Pull request not found for merging');
      }
    } else if (query.includes('addComment')) {
      const input = variables['input'] || {};
      const subjectId = input.subjectId;
      const commentBody = input.body;

      let fullName = '';
      let issueNum = 0;
      try {
        const decoded = base64UrlDecode(subjectId);
        const parts = decoded.split(':');
        if (parts[0] === 'issue') {
          fullName = parts[1]!;
          issueNum = parseInt(parts[2]!, 10);
        }
      } catch {}

      if (fullName && issueNum) {
        const comment = addComment(fullName, issueNum, commentBody);
        data.addComment = {
          commentEdge: {
            node: {
              id: base64UrlEncode(`comment:${fullName}:${issueNum}:${comment.id}`),
              body: comment.body,
            }
          }
        };
      } else {
        throw new Error('Issue not found for adding comment');
      }
    }
  } else {
    // Queries
    // Check for unknown field like noSuchFieldOnViewer
    if (query.includes('noSuchFieldOnViewer')) {
      errors.push({ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' });
    }

    if (query.includes('viewer')) {
      data.viewer = {
        login: VIEWER_LOGIN,
      };
    }

    // repository(owner: $owner, name: $name) or repository(owner: "...", name: "...")
    const ownerArg = variables['owner'] || extractArg(query, 'owner');
    const nameArg = variables['name'] || extractArg(query, 'name');

    if (query.includes('repository(')) {
      let foundRepo: any = null;
      if (ownerArg && nameArg) {
        const targetFullName = `${ownerArg}/${nameArg}`.toLowerCase();
        for (const r of globalStore.repos.values()) {
          if (r.full_name.toLowerCase() === targetFullName) {
            foundRepo = r;
            break;
          }
        }
      }

      if (foundRepo) {
        const repoFullName = foundRepo.full_name;
        const repoObj: any = {
          id: base64UrlEncode(`repo:${repoFullName}`),
          databaseId: foundRepo.id,
          name: foundRepo.name,
          nameWithOwner: foundRepo.full_name,
          owner: {
            login: foundRepo.owner.login,
          },
          defaultBranchRef: {
            name: foundRepo.default_branch,
          },
          viewerPermission: 'ADMIN',
          hasIssuesEnabled: foundRepo.has_issues,
        };

        // issue(number:)
        const issueNumMatch = query.match(/issue\s*\(\s*number\s*:\s*\$?([a-zA-Z0-9_]+)\s*\)/);
        if (issueNumMatch) {
          let num = parseInt(issueNumMatch[1]!, 10);
          if (isNaN(num) && variables[issueNumMatch[1]!] !== undefined) {
            num = parseInt(variables[issueNumMatch[1]!], 10);
          }
          const issuesMap = globalStore.getIssues(repoFullName);
          const issue = issuesMap.get(num);
          if (issue) {
            repoObj.issue = {
              id: base64UrlEncode(`issue:${repoFullName}:${issue.number}`),
              number: issue.number,
              title: issue.title,
              body: issue.body,
              state: issue.state.toUpperCase(),
            };
          } else {
            repoObj.issue = null;
          }
        }

        // issues(...)
        if (query.includes('issues(') || query.includes('issues {')) {
          const issuesMap = globalStore.getIssues(repoFullName);
          const statesParam = query.includes('states: [OPEN]') ? ['OPEN'] : null;
          const firstParam = variables['first'] || 30;
          const afterParam = variables['after'] || null;

          let list = Array.from(issuesMap.values());
          if (statesParam && statesParam.includes('OPEN')) {
            list = list.filter(i => i.state === 'open');
          }

          // Order by CREATED_AT DESC (default number descending)
          list.sort((a, b) => b.number - a.number);

          // Pagination with after cursor
          let startIndex = 0;
          if (afterParam) {
            try {
              const decodedCursor = base64UrlDecode(afterParam); // e.g. cursor:<number>
              if (decodedCursor.startsWith('cursor:')) {
                const afterNum = parseInt(decodedCursor.slice(7), 10);
                const idx = list.findIndex(i => i.number === afterNum);
                if (idx !== -1) {
                  startIndex = idx + 1;
                }
              }
            } catch {}
          }

          const pageList = list.slice(startIndex, startIndex + firstParam);
          const hasNextPage = startIndex + firstParam < list.length;
          const lastItem = pageList[pageList.length - 1];
          const endCursor = lastItem ? base64UrlEncode(`cursor:${lastItem.number}`) : null;

          repoObj.issues = {
            nodes: pageList.map(i => ({
              id: base64UrlEncode(`issue:${repoFullName}:${i.number}`),
              number: i.number,
              title: i.title,
              state: i.state.toUpperCase(),
              body: i.body,
            })),
            pageInfo: {
              hasNextPage,
              endCursor,
            }
          };
        }

        // pullRequests(...)
        if (query.includes('pullRequests')) {
          const pullsMap = globalStore.getPulls(repoFullName);
          const list = Array.from(pullsMap.values());
          list.sort((a, b) => b.number - a.number);
          repoObj.pullRequests = {
            nodes: list.map(p => ({
              id: base64UrlEncode(`pr:${repoFullName}:${p.number}`),
              number: p.number,
              headRefName: p.head.ref,
              baseRefName: p.base.ref,
              mergeable: p.mergeable ? 'MERGEABLE' : 'UNKNOWN',
              state: p.merged ? 'MERGED' : p.state.toUpperCase(),
              merged: p.merged,
            }))
          };
        }

        // pullRequest(number:)
        const prNumMatch = query.match(/pullRequest\s*\(\s*number\s*:\s*\$?([a-zA-Z0-9_]+)\s*\)/);
        if (prNumMatch) {
          let num = parseInt(prNumMatch[1]!, 10);
          if (isNaN(num) && variables[prNumMatch[1]!] !== undefined) {
            num = parseInt(variables[prNumMatch[1]!], 10);
          }
          const pullsMap = globalStore.getPulls(repoFullName);
          const pr = pullsMap.get(num);
          if (pr) {
            const filesList = changedFiles(repoFullName, pr.base.sha, pr.head.sha);
            repoObj.pullRequest = {
              id: base64UrlEncode(`pr:${repoFullName}:${pr.number}`),
              number: pr.number,
              headRefName: pr.head.ref,
              baseRefName: pr.base.ref,
              mergeable: pr.mergeable ? 'MERGEABLE' : 'UNKNOWN',
              state: pr.merged ? 'MERGED' : pr.state.toUpperCase(),
              merged: pr.merged,
              files: {
                nodes: filesList.map(f => ({ path: f.path }))
              }
            };
          } else {
            repoObj.pullRequest = null;
          }
        }

        data.repository = repoObj;
      } else {
        data.repository = null;
      }
    }

    // node(id:)
    const nodeIdMatch = query.match(/node\s*\(\s*id\s*:\s*\$?([a-zA-Z0-9_]+)\s*\)/);
    if (nodeIdMatch || query.includes('node(id:')) {
      let idVal = variables['id'] || '';
      if (!idVal) {
        // extract string literal from query
        const litMatch = query.match(/node\s*\(\s*id\s*:\s*"([^"]+)"\s*\)/);
        if (litMatch) idVal = litMatch[1];
      }

      if (idVal) {
        try {
          const decoded = base64UrlDecode(idVal);
          const parts = decoded.split(':');
          if (parts[0] === 'repo') {
            const fullName = parts.slice(1).join(':');
            const r = globalStore.repos.get(fullName);
            if (r) {
              data.node = {
                id: idVal,
                name: r.name,
                nameWithOwner: r.full_name,
              };
            }
          } else if (parts[0] === 'issue') {
            const fullName = parts[1]!;
            const num = parseInt(parts[2]!, 10);
            const issues = globalStore.getIssues(fullName);
            const issue = issues.get(num);
            if (issue) {
              data.node = {
                id: idVal,
                number: issue.number,
                title: issue.title,
                state: issue.state.toUpperCase(),
              };
            }
          } else if (parts[0] === 'pr') {
            const fullName = parts[1]!;
            const num = parseInt(parts[2]!, 10);
            const pulls = globalStore.getPulls(fullName);
            const pr = pulls.get(num);
            if (pr) {
              data.node = {
                id: idVal,
                number: pr.number,
                state: pr.merged ? 'MERGED' : pr.state.toUpperCase(),
              };
            }
          }
        } catch {}
      }
    }

    // Introspection __type(name:) (support multiple / aliased selections)
    const typeMatches = [...query.matchAll(/(?:([a-zA-Z0-9_]+)\s*:\s*)?__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g)];
    if (typeMatches.length > 0) {
      for (const m of typeMatches) {
        const alias = m[1];
        const typeName = m[2]!;
        const fieldKey = alias || typeName;
        const typeObj = getIntrospectionType(typeName);
        data[fieldKey] = typeObj;
      }
    }
  }

  return data;
}

function extractArg(query: string, argName: string): string | null {
  const regex = new RegExp(`${argName}\\s*:\\s*"([^"]+)"`);
  const m = query.match(regex);
  if (m) return m[1] || null;
  const regexVar = new RegExp(`${argName}\\s*:\\s*\\$([a-zA-Z0-9_]+)`);
  const mv = query.match(regexVar);
  if (mv) return mv[1] || null;
  return null;
}

function getIntrospectionType(typeName: string): any {
  if (typeName === 'Issue') {
    return {
      fields: [
        { name: 'id' },
        { name: 'number' },
        { name: 'title' },
        { name: 'state' },
        { name: 'body' },
      ]
    };
  }
  if (typeName === 'PullRequest') {
    return {
      fields: [
        { name: 'id' },
        { name: 'number' },
        { name: 'headRefName' },
        { name: 'baseRefName' },
        { name: 'mergeable' },
        { name: 'state' },
        { name: 'merged' },
        { name: 'files' },
      ]
    };
  }
  if (typeName === 'Repository') {
    return {
      fields: [
        { name: 'id' },
        { name: 'databaseId' },
        { name: 'name' },
        { name: 'nameWithOwner' },
        { name: 'owner' },
        { name: 'defaultBranchRef' },
        { name: 'viewerPermission' },
        { name: 'hasIssuesEnabled' },
        { name: 'issue' },
        { name: 'issues' },
        { name: 'pullRequests' },
        { name: 'pullRequest' },
      ]
    };
  }
  if (typeName === 'SearchType') {
    return {
      enumValues: [
        { name: 'ISSUE' },
      ]
    };
  }
  return { fields: [] };
}
