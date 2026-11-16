import type { IncomingMessage, ServerResponse } from 'node:http';
import { globalStore } from './store.ts';
import type { Repository, Issue, PullRequest, IssueComment, Label } from './store.ts';
import { VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL } from './viewer.ts';
import { changedFiles, mergePullRequest, createRepo } from './service.ts';
import { randomBytes } from 'node:crypto';

export function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/v3')) {
    return false;
  }

  // Request ID header
  const requestId = randomBytes(8).toString('hex');
  res.setHeader('X-GitHub-Request-Id', requestId);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Auth check (except for healthz which is handled outside, but /api/v3 requires auth)
  const authHeader = req.headers['authorization'];
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN || '';
  if (expectedToken !== '') {
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7).trim() !== expectedToken) {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: 'Requires authentication' }));
      return true;
    }
  }

  // Parse body for POST/PUT/PATCH
  // We'll read body asynchronously if needed, but let's handle synchronous routing and helper for body.
  const handleWithBody = async () => {
    let rawBody = '';
    if (['POST', 'PUT', 'PATCH'].includes(req.method || '')) {
      for await (const chunk of req) {
        rawBody += chunk;
      }
    }

    let bodyData: any = {};
    if (rawBody.trim() !== '') {
      try {
        bodyData = JSON.parse(rawBody);
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ message: 'Problems parsing JSON' }));
        return;
      }
    }

    const subpath = pathname.slice('/api/v3'.length);
    const method = req.method || 'GET';

    // Helper for responding with JSON
    const json = (data: any, status = 200, extraHeaders?: Record<string, string>) => {
      res.statusCode = status;
      if (extraHeaders) {
        for (const [k, v] of Object.entries(extraHeaders)) {
          res.setHeader(k, v);
        }
      }
      res.end(JSON.stringify(data));
    };

    const error = (msg: string, status = 404) => {
      json({ message: msg }, status);
    };

    // 1. GET /api/v3/ or /api/v3
    if (subpath === '/' || subpath === '') {
      if (method === 'GET') {
        json({}, 200, { 'X-OAuth-Scopes': 'repo, read:org' });
        return;
      }
    }

    // 2. GET /api/v3/meta
    if (subpath === '/meta') {
      if (method === 'GET') {
        json({ installed_version: '1.0.0' });
        return;
      }
    }

    // 3. GET /api/v3/user
    if (subpath === '/user') {
      if (method === 'GET') {
        json({
          login: VIEWER_LOGIN,
          id: VIEWER_ID,
          node_id: 'MDQ6VXNlcjE=',
          avatar_url: `https://github.images.example/u/${VIEWER_ID}?v=4`,
          gravatar_id: '',
          url: `https://api.github.com/users/${VIEWER_LOGIN}`,
          html_url: `https://github.com/${VIEWER_LOGIN}`,
          type: 'User',
          site_admin: false,
          name: VIEWER_NAME,
          email: VIEWER_EMAIL,
          public_repos: 30,
          owned_private_repos: 30,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        });
        return;
      }
    }

    // 4. GET /api/v3/user/repos and POST /api/v3/user/repos
    if (subpath === '/user/repos') {
      if (method === 'GET') {
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const perPage = parseInt(url.searchParams.get('per_page') || '30', 10);
        
        const userRepos: Repository[] = [];
        for (const repo of globalStore.repos.values()) {
          if (repo.owner.login.toLowerCase() === VIEWER_LOGIN.toLowerCase()) {
            userRepos.push(repo);
          }
        }
        userRepos.sort((a, b) => a.id - b.id);

        const start = (page - 1) * perPage;
        const pageRepos = userRepos.slice(start, start + perPage);

        // Link header for pagination
        const hasNext = start + perPage < userRepos.length;
        if (hasNext) {
          const nextUrl = `${url.origin}${url.pathname}?page=${page + 1}&per_page=${perPage}`;
          res.setHeader('Link', `<${nextUrl}>; rel="next"`);
        }

        json(pageRepos);
        return;
      }

      if (method === 'POST') {
        const { name, description, private: isPrivate } = bodyData;
        if (!name || typeof name !== 'string') {
            error('Repository name is required', 422);
            return;
        }
        const fullName = `${VIEWER_LOGIN}/${name}`;
        if (globalStore.repos.has(fullName)) {
          error('Repository already exists', 422);
          return;
        }

        try {
          const repo = createRepo(name, { private: isPrivate, description }, VIEWER_LOGIN);
          json(repo, 201);
          return;
        } catch (err: any) {
          error(err.message, 422);
          return;
        }
      }
    }

    // 5. /api/v3/repos/{owner}/{repo}/...
    const repoMatch = subpath.match(/^\/repos\/([^/]+)\/([^/]+)([\/]?.*)$/);
    if (repoMatch) {
      const owner = repoMatch[1]!;
      const repoName = repoMatch[2]!;
      const restPath = repoMatch[3]!;
      const fullName = `${owner}/${repoName}`;

      const repo = globalStore.repos.get(fullName);
      if (!repo) {
        // If repo does not exist, return 404
        error('Not Found', 404);
        return;
      }

      // Root repository endpoint: GET, PATCH, DELETE /api/v3/repos/{owner}/{repo}
      if (restPath === '' || restPath === '/') {
        if (method === 'GET') {
          json(repo);
          return;
        }
        if (method === 'PATCH') {
          if (bodyData.description !== undefined) {
            repo.description = bodyData.description;
          }
          repo.updated_at = new Date().toISOString();
          json(repo);
          return;
        }
        if (method === 'DELETE') {
          globalStore.repos.delete(fullName);
          globalStore.repoObjects.delete(fullName);
          globalStore.repoRefs.delete(fullName);
          globalStore.repoIssues.delete(fullName);
          globalStore.repoPulls.delete(fullName);
          globalStore.repoLabels.delete(fullName);
          globalStore.repoIssueComments.delete(fullName);
          res.statusCode = 204;
          res.end();
          return;
        }
      }

      // Branches: GET /api/v3/repos/{owner}/{repo}/branches and /branches/{branch}
      if (restPath.startsWith('/branches')) {
        const branchSub = restPath.slice('/branches'.length);
        const refs = globalStore.getRefs(fullName);
        if (branchSub === '' || branchSub === '/') {
          if (method === 'GET') {
            const list: any[] = [];
            for (const [refName, sha] of refs.entries()) {
              if (refName.startsWith('refs/heads/')) {
                const name = refName.slice('refs/heads/'.length);
                list.push({
                  name,
                  commit: { sha, url: `https://api.github.com/repos/${fullName}/commits/${sha}` },
                  protected: false,
                });
              }
            }
            json(list);
            return;
          }
        } else {
          const branchName = branchSub.slice(1);
          const sha = refs.get(`refs/heads/${branchName}`);
          if (method === 'GET' && sha) {
            json({
              name: branchName,
              commit: { sha, url: `https://api.github.com/repos/${fullName}/commits/${sha}` },
              protected: false,
            });
            return;
          } else if (method === 'GET') {
            error('Branch not found', 404);
            return;
          }
        }
      }

      // Commits: GET /api/v3/repos/{owner}/{repo}/commits and /commits/{sha}
      if (restPath.startsWith('/commits')) {
        const commitSub = restPath.slice('/commits'.length);
        if (commitSub === '' || commitSub === '/') {
          if (method === 'GET') {
            const refParam = url.searchParams.get('sha') || repo.default_branch;
            const refs = globalStore.getRefs(fullName);
            const headSha = refs.get(`refs/heads/${refParam}`) || refs.get(refParam) || refParam;
            
            const commits: any[] = [];
            let currSha = headSha;
            const visited = new Set<string>();
            while (currSha && !visited.has(currSha)) {
              visited.add(currSha);
              const obj = globalStore.readObject(fullName, currSha);
              if (!obj || obj.type !== 'commit') break;
              const text = obj.content.toString('utf8');
              const parents: string[] = [];
              let message = '';
              let treeSha = '';
              let authorName = 'forge';
              let authorEmail = 'forge@localhost';
              let authorDate = new Date().toISOString();

              const lines = text.split('\n');
              let headerDone = false;
              const msgLines: string[] = [];
              for (const line of lines) {
                if (!headerDone) {
                  if (line === '') {
                    headerDone = true;
                    continue;
                  }
                  if (line.startsWith('tree ')) treeSha = line.slice(5).trim();
                  else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
                  else if (line.startsWith('author ')) {
                    const m = line.match(/^author\s+(.+)\s+<([^>]+)>\s+(.+)$/);
                    if (m) {
                      authorName = m[1]!;
                      authorEmail = m[2]!;
                    }
                  }
                } else {
                  msgLines.push(line);
                }
              }
              message = msgLines.join('\n').trim();

              commits.push({
                sha: currSha,
                node_id: `C_kgD${currSha.slice(0, 7)}`,
                commit: {
                  author: { name: authorName, email: authorEmail, date: authorDate },
                  committer: { name: authorName, email: authorEmail, date: authorDate },
                  message,
                  tree: { sha: treeSha, url: `https://api.github.com/repos/${fullName}/git/trees/${treeSha}` },
                  url: `https://api.github.com/repos/${fullName}/git/commits/${currSha}`,
                  comment_count: 0,
                },
                author: { login: repo.owner.login, id: repo.owner.id, type: 'User' },
                committer: { login: repo.owner.login, id: repo.owner.id, type: 'User' },
                parents: parents.map(p => ({ sha: p, url: `https://api.github.com/repos/${fullName}/commits/${p}` })),
                html_url: `https://github.com/${fullName}/commit/${currSha}`,
                url: `https://api.github.com/repos/${fullName}/commits/${currSha}`,
              });

              currSha = parents[0] || '';
            }
            json(commits);
            return;
          }
        } else {
          const sha = commitSub.slice(1);
          const obj = globalStore.readObject(fullName, sha);
          if (method === 'GET' && obj && obj.type === 'commit') {
            const text = obj.content.toString('utf8');
            const parents: string[] = [];
            let treeSha = '';
            let message = '';
            const lines = text.split('\n');
            let headerDone = false;
            const msgLines: string[] = [];
            for (const line of lines) {
              if (!headerDone) {
                if (line === '') {
                  headerDone = true;
                  continue;
                }
                if (line.startsWith('tree ')) treeSha = line.slice(5).trim();
                else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
              } else {
                msgLines.push(line);
              }
            }
            message = msgLines.join('\n').trim();
            json({
              sha,
              node_id: `C_kgD${sha.slice(0, 7)}`,
              commit: {
                author: { name: 'forge', email: 'forge@localhost', date: new Date().toISOString() },
                committer: { name: 'forge', email: 'forge@localhost', date: new Date().toISOString() },
                message,
                tree: { sha: treeSha },
              },
              parents: parents.map(p => ({ sha: p })),
              html_url: `https://github.com/${fullName}/commit/${sha}`,
              url: `https://api.github.com/repos/${fullName}/commits/${sha}`,
            });
            return;
          } else if (method === 'GET') {
            error('Commit not found', 404);
            return;
          }
        }
      }

      // Git Refs: GET /api/v3/repos/{owner}/{repo}/git/refs/heads/{branch} and POST /api/v3/repos/{owner}/{repo}/git/refs
      if (restPath.startsWith('/git/refs')) {
        const refsSub = restPath.slice('/git/refs'.length);
        const refs = globalStore.getRefs(fullName);
        if (method === 'GET' && refsSub.startsWith('/heads/')) {
          const branchName = refsSub.slice('/heads/'.length);
          const sha = refs.get(`refs/heads/${branchName}`);
          if (sha) {
            json({
              ref: `refs/heads/${branchName}`,
              node_id: `REF_${branchName}`,
              url: `https://api.github.com/repos/${fullName}/git/refs/heads/${branchName}`,
              object: { type: 'commit', sha, url: `https://api.github.com/repos/${fullName}/git/commits/${sha}` },
            });
            return;
          } else {
            error('Ref not found', 404);
            return;
          }
        }
        if (method === 'POST' && (refsSub === '' || refsSub === '/')) {
          const { ref, sha } = bodyData;
          if (ref && sha) {
            refs.set(ref, sha);
            json({
              ref,
              node_id: `REF_NEW`,
              url: `https://api.github.com/repos/${fullName}/git/${ref}`,
              object: { type: 'commit', sha, url: `https://api.github.com/repos/${fullName}/git/commits/${sha}` },
            }, 201);
            return;
          }
        }
      }

      // Contents: /api/v3/repos/{owner}/{repo}/contents/{path}
      if (restPath.startsWith('/contents/')) {
        const filePath = restPath.slice('/contents/'.length);
        const pathParts = filePath.split('/').filter(Boolean);
        const refs = globalStore.getRefs(fullName);
        const branch = bodyData.branch || url.searchParams.get('ref') || repo.default_branch;
        const refKey = `refs/heads/${branch}`;
        const headSha = refs.get(refKey);

        if (method === 'GET') {
          if (!headSha) {
            // Empty repo or branch
            error('This repository is empty.', 404);
            return;
          }
          const commitObj = globalStore.readObject(fullName, headSha);
          if (!commitObj || commitObj.type !== 'commit') {
            error('Not Found', 404);
            return;
          }
          let treeSha = '';
          for (const line of commitObj.content.toString('utf8').split('\n')) {
            if (line.startsWith('tree ')) {
              treeSha = line.slice(5).trim();
              break;
            }
          }

          if (pathParts.length === 0) {
            // Root tree listing
            const entries = globalStore.parseTree(fullName, treeSha);
            const listing = entries.map(e => ({
              name: e.name,
              path: e.name,
              sha: e.sha,
              size: 0,
              url: `https://api.github.com/repos/${fullName}/contents/${e.name}`,
              html_url: `https://github.com/${fullName}/blob/main/${e.name}`,
              git_url: `https://api.github.com/repos/${fullName}/git/blobs/${e.sha}`,
              download_url: `https://raw.githubusercontent.com/${fullName}/main/${e.name}`,
              type: e.type,
              _links: { self: `https://api.github.com/repos/${fullName}/contents/${e.name}` },
            }));
            json(listing);
            return;
          }

          const fileInfo = globalStore.getFileAtPath(fullName, treeSha, pathParts);
          if (!fileInfo) {
            error('Not Found', 404);
            return;
          }

          const baseName = pathParts[pathParts.length - 1]!;
          const contentBase64 = fileInfo.content.toString('base64');

          json({
            name: baseName,
            path: filePath,
            sha: fileInfo.sha,
            size: fileInfo.content.length,
            url: `https://api.github.com/repos/${fullName}/contents/${filePath}`,
            html_url: `https://github.com/${fullName}/blob/main/${filePath}`,
            git_url: `https://api.github.com/repos/${fullName}/git/blobs/${fileInfo.sha}`,
            download_url: `https://raw.githubusercontent.com/${fullName}/main/${filePath}`,
            type: 'file',
            content: contentBase64,
            encoding: 'base64',
            _links: {
              self: `https://api.github.com/repos/${fullName}/contents/${filePath}`,
              git: `https://api.github.com/repos/${fullName}/git/blobs/${fileInfo.sha}`,
              html: `https://github.com/${fullName}/blob/main/${filePath}`,
            },
          });
          return;
        }

        if (method === 'PUT') {
          const { message, content: contentBase64, sha: expectedSha } = bodyData;
          if (!message || typeof contentBase64 !== 'string') {
            error('Message and content are required', 422);
            return;
          }

          const fileBuffer = Buffer.from(contentBase64, 'base64');
          const newBlobSha = globalStore.writeBlob(fullName, fileBuffer);

          let currentTreeSha = '0'.repeat(40);
          const parents: string[] = [];
          if (headSha) {
            parents.push(headSha);
            const commitObj = globalStore.readObject(fullName, headSha);
            if (commitObj && commitObj.type === 'commit') {
              for (const line of commitObj.content.toString('utf8').split('\n')) {
                if (line.startsWith('tree ')) {
                  currentTreeSha = line.slice(5).trim();
                }
              }
            }
          }

          // Check stale sha if expectedSha is provided
          if (expectedSha) {
            const existing = globalStore.getFileAtPath(fullName, currentTreeSha, pathParts);
            if (!existing || existing.sha !== expectedSha) {
              error('Stale sha', 409);
              return;
            }
          }

          const newTreeSha = globalStore.updateTreeAtPath(fullName, currentTreeSha, pathParts, newBlobSha);
          const newCommitSha = globalStore.writeCommit(fullName, {
            treeSha: newTreeSha,
            parents,
            message,
          });

          refs.set(refKey, newCommitSha);
          repo.pushed_at = new Date().toISOString();

          const isCreate = !headSha || parents.length === 0;
          const baseName = pathParts[pathParts.length - 1]!;

          json({
            content: {
              name: baseName,
              path: filePath,
              sha: newBlobSha,
              size: fileBuffer.length,
              url: `https://api.github.com/repos/${fullName}/contents/${filePath}`,
              type: 'file',
              encoding: 'base64',
            },
            commit: {
              sha: newCommitSha,
              node_id: `C_${newCommitSha.slice(0, 7)}`,
              url: `https://api.github.com/repos/${fullName}/commits/${newCommitSha}`,
              html_url: `https://github.com/${fullName}/commit/${newCommitSha}`,
              author: { name: 'forge', email: 'forge@localhost', date: new Date().toISOString() },
              committer: { name: 'forge', email: 'forge@localhost', date: new Date().toISOString() },
              message,
            },
          }, isCreate ? 201 : 200);
          return;
        }

        if (method === 'DELETE') {
          const { message, sha: expectedSha } = bodyData;
          if (!message || !expectedSha) {
            error('Message and sha are required', 422);
            return;
          }

          if (!headSha) {
            error('Not Found', 404);
            return;
          }

          let currentTreeSha = '0'.repeat(40);
          const commitObj = globalStore.readObject(fullName, headSha);
          if (commitObj && commitObj.type === 'commit') {
            for (const line of commitObj.content.toString('utf8').split('\n')) {
              if (line.startsWith('tree ')) {
                currentTreeSha = line.slice(5).trim();
              }
            }
          }

          const existing = globalStore.getFileAtPath(fullName, currentTreeSha, pathParts);
          if (!existing || existing.sha !== expectedSha) {
            error('Stale or missing sha', 409);
            return;
          }

          const newTreeSha = globalStore.updateTreeAtPath(fullName, currentTreeSha, pathParts, null);
          const newCommitSha = globalStore.writeCommit(fullName, {
            treeSha: newTreeSha,
            parents: [headSha],
            message,
          });

          refs.set(refKey, newCommitSha);
          repo.pushed_at = new Date().toISOString();

          json({
            commit: {
              sha: newCommitSha,
              node_id: `C_${newCommitSha.slice(0, 7)}`,
              url: `https://api.github.com/repos/${fullName}/commits/${newCommitSha}`,
              html_url: `https://github.com/${fullName}/commit/${newCommitSha}`,
              message,
            },
          });
          return;
        }
      }

      // Labels: POST /api/v3/repos/{owner}/{repo}/labels
      if (restPath === '/labels' && method === 'POST') {
        const { name, color, description } = bodyData;
        if (!name || typeof name !== 'string') {
          error('Label name is required', 422);
          return;
        }
        const labelsMap = globalStore.getLabels(fullName);
        const label: Label = {
          id: labelsMap.size + 1,
          node_id: `LA_kwD${name}`,
          name,
          color: color || 'ededed',
          default: true,
          description: description || null,
        };
        labelsMap.set(name, label);
        json(label, 201);
        return;
      }

      // Issues: /api/v3/repos/{owner}/{repo}/issues
      if (restPath.startsWith('/issues')) {
        const issuesSub = restPath.slice('/issues'.length);
        const issuesMap = globalStore.getIssues(fullName);
        const labelsMap = globalStore.getLabels(fullName);

        if (issuesSub === '' || issuesSub === '/') {
          if (method === 'GET') {
            const stateParam = url.searchParams.get('state') || 'open';
            const page = parseInt(url.searchParams.get('page') || '1', 10);
            const perPage = parseInt(url.searchParams.get('per_page') || '30', 10);

            const list: Issue[] = [];
            for (const issue of issuesMap.values()) {
              if (stateParam === 'all' || issue.state === stateParam) {
                list.push(issue);
              }
            }
            list.sort((a, b) => b.number - a.number);
            const start = (page - 1) * perPage;
            json(list.slice(start, start + perPage));
            return;
          }

          if (method === 'POST') {
            const { title, body, labels: labelNames } = bodyData;
            if (!title || typeof title !== 'string') {
              error('Title is required', 422);
              return;
            }

            const issueLabels: Label[] = [];
            if (Array.isArray(labelNames)) {
              for (const lName of labelNames) {
                const labelObj = labelsMap.get(lName);
                if (!labelObj) {
                  // 422 when it names a label that does not exist
                  error(`Label ${lName} does not exist`, 422);
                  return;
                }
                issueLabels.push(labelObj);
              }
            }

            const number = globalStore.issueCounter++;
            const now = new Date().toISOString();
            const issue: Issue = {
              id: 10000 + number,
              node_id: `I_kwD${number}`,
              number,
              title,
              body: body || null,
              state: 'open',
              labels: issueLabels,
              user: { login: repo.owner.login },
              assignee: null,
              created_at: now,
              updated_at: now,
              closed_at: null,
              html_url: `https://github.com/${fullName}/issues/${number}`,
              url: `https://api.github.com/repos/${fullName}/issues/${number}`,
              repository_url: `https://api.github.com/repos/${fullName}`,
              comments: 0,
              locked: false,
            };

            issuesMap.set(number, issue);
            repo.open_issues_count++;
            json(issue, 201);
            return;
          }
        } else {
          // /issues/{number} or /issues/{number}/comments
          const issueMatch = issuesSub.match(/^\/(\d+)([\/]?.*)$/);
          if (issueMatch) {
            const issueNum = parseInt(issueMatch[1]!, 10);
            const issueSubPath = issueMatch[2]!;
            const issue = issuesMap.get(issueNum);

            if (!issue) {
              error('Issue not found', 404);
              return;
            }

            if (issueSubPath.startsWith('/comments')) {
              const commentsMap = globalStore.getIssueComments(fullName);
              const commentsList = commentsMap.get(issueNum) || [];
              if (method === 'GET') {
                json(commentsList);
                return;
              }
              if (method === 'POST') {
                const { body: commentBody } = bodyData;
                if (!commentBody) {
                  error('Comment body required', 422);
                  return;
                }
                const now = new Date().toISOString();
                const comment: IssueComment = {
                  id: commentsList.length + 1,
                  node_id: `IC_kwD${commentBody.slice(0, 5)}`,
                  body: commentBody,
                  user: { login: repo.owner.login },
                  created_at: now,
                  updated_at: now,
                  html_url: `https://github.com/${fullName}/issues/${issueNum}#issuecomment-${commentsList.length + 1}`,
                  url: `https://api.github.com/repos/${fullName}/issues/comments/${commentsList.length + 1}`,
                };
                commentsList.push(comment);
                commentsMap.set(issueNum, commentsList);
                issue.comments = commentsList.length;
                json(comment, 201);
                return;
              }
            }

            if (issueSubPath === '' || issueSubPath === '/') {
              if (method === 'GET') {
                json(issue);
                return;
              }
              if (method === 'PATCH') {
                const { title, body, state, labels: labelNames } = bodyData;
                if (title !== undefined) issue.title = title;
                if (body !== undefined) issue.body = body;
                if (state !== undefined) {
                  issue.state = state;
                  if (state === 'closed' && issue.closed_at === null) {
                    issue.closed_at = new Date().toISOString();
                    repo.open_issues_count = Math.max(0, repo.open_issues_count - 1);
                  } else if (state === 'open' && issue.closed_at !== null) {
                    issue.closed_at = null;
                    repo.open_issues_count++;
                  }
                }
                if (labelNames !== undefined) {
                  const issueLabels: Label[] = [];
                  for (const lName of labelNames) {
                    const labelObj = labelsMap.get(lName);
                    if (labelObj) issueLabels.push(labelObj);
                  }
                  issue.labels = issueLabels;
                }
                issue.updated_at = new Date().toISOString();
                json(issue);
                return;
              }
            }
          }
        }
      }

      // Pulls: /api/v3/repos/{owner}/{repo}/pulls
      if (restPath.startsWith('/pulls')) {
        const pullsSub = restPath.slice('/pulls'.length);
        const pullsMap = globalStore.getPulls(fullName);
        const refs = globalStore.getRefs(fullName);

        if (pullsSub === '' || pullsSub === '/') {
          if (method === 'GET') {
            const stateParam = url.searchParams.get('state') || 'open';
            const list: PullRequest[] = [];
            for (const pull of pullsMap.values()) {
              if (stateParam === 'all' || pull.state === stateParam) {
                list.push(pull);
              }
            }
            list.sort((a, b) => b.number - a.number);
            json(list);
            return;
          }

          if (method === 'POST') {
            const { title, body, head, base } = bodyData;
            if (!title || !head || !base) {
              error('Title, head, and base are required', 422);
              return;
            }

            const headSha = refs.get(`refs/heads/${head}`);
            const baseSha = refs.get(`refs/heads/${base}`);
            if (!headSha || !baseSha) {
              error('Head or base branch does not exist', 422);
              return;
            }

            const number = globalStore.pullCounter++;
            const now = new Date().toISOString();
            const pull: PullRequest = {
              id: 20000 + number,
              node_id: `PR_kwD${number}`,
              number,
              title,
              body: body || null,
              state: 'open',
              locked: false,
              head: {
                label: `${repo.owner.login}:${head}`,
                ref: head,
                sha: headSha,
                repo,
              },
              base: {
                label: `${repo.owner.login}:${base}`,
                ref: base,
                sha: baseSha,
                repo,
              },
              merged: false,
              mergeable: true,
              merge_commit_sha: null,
              created_at: now,
              updated_at: now,
              closed_at: null,
              merged_at: null,
              user: { login: repo.owner.login },
              html_url: `https://github.com/${fullName}/pull/${number}`,
              url: `https://api.github.com/repos/${fullName}/pulls/${number}`,
              draft: false,
            };

            pullsMap.set(number, pull);
            json(pull, 201);
            return;
          }
        } else {
          // /pulls/{number} or /pulls/{number}/merge or /pulls/{number}/files
          const pullMatch = pullsSub.match(/^\/(\d+)([\/]?.*)$/);
          if (pullMatch) {
            const pullNum = parseInt(pullMatch[1]!, 10);
            const pullSubPath = pullMatch[2]!;
            const pull = pullsMap.get(pullNum);

            if (!pull) {
              error('Pull request not found', 404);
              return;
            }

            if (pullSubPath === '/files' && method === 'GET') {
              const baseSha = refs.get(`refs/heads/${pull.base.ref}`);
              if (!baseSha) {
                json([]);
                return;
              }
              const files = changedFiles(fullName, baseSha, pull.head.sha);
              json(files);
              return;
            }

            if (pullSubPath === '/merge' && method === 'PUT') {
              try {
                const resObj = mergePullRequest(fullName, pullNum);
                json(resObj);
                return;
              } catch (err: any) {
                if (err.message.includes('conflict')) {
                  error(err.message, 405);
                } else {
                  error(err.message, 422);
                }
                return;
              }
            }

            if (pullSubPath === '' || pullSubPath === '/') {
              if (method === 'GET') {
                json(pull);
                return;
              }
            }
          }
        }
      }
    }

    // Unknown route
    error('Not Found', 404);
  };

  handleWithBody().catch(err => {
    res.statusCode = 500;
    res.end(JSON.stringify({ message: err.message || 'Internal Server Error' }));
  });

  return true;
}
