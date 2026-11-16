import { globalStore } from './store.ts';
import type { Repository, Issue, PullRequest, IssueComment, Label } from './store.ts';
import { VIEWER_LOGIN, VIEWER_ID } from './viewer.ts';

export function createRepo(name: string, opts?: { private?: boolean; description?: string }, ownerLogin = VIEWER_LOGIN): Repository {
  const fullName = `${ownerLogin}/${name}`;
  if (globalStore.repos.has(fullName)) {
    throw new Error('Repository already exists');
  }

  const repoId = ++globalStore.repoIdCounter;
  const now = new Date().toISOString();
  const repo: Repository = {
    id: repoId,
    node_id: `R_kgD${repoId}`,
    name,
    full_name: fullName,
    owner: { login: ownerLogin, id: ownerLogin === VIEWER_LOGIN ? VIEWER_ID : 2000, type: 'User' },
    private: !!opts?.private,
    description: opts?.description || null,
    default_branch: 'main',
    created_at: now,
    updated_at: now,
    pushed_at: now,
    html_url: `https://github.com/${fullName}`,
    url: `https://api.github.com/repos/${fullName}`,
    clone_url: `https://github.com/${fullName}.git`,
    git_url: `git://github.com/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    fork: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    size: 0,
    open_issues_count: 0,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    language: null,
    topics: [],
    visibility: opts?.private ? 'private' : 'public',
  };

  globalStore.repos.set(fullName, repo);
  return repo;
}

export function createIssue(fullName: string, title: string, body?: string | null): Issue {
  const repo = globalStore.repos.get(fullName);
  if (!repo) throw new Error('Repository not found');
  const issuesMap = globalStore.getIssues(fullName);

  const number = globalStore.issueCounter++;
  const now = new Date().toISOString();
  const issue: Issue = {
    id: 10000 + number,
    node_id: `I_kwD${number}`,
    number,
    title,
    body: body || null,
    state: 'open',
    labels: [],
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
  return issue;
}

export function closeIssue(fullName: string, number: number): Issue {
  const repo = globalStore.repos.get(fullName);
  if (!repo) throw new Error('Repository not found');
  const issuesMap = globalStore.getIssues(fullName);
  const issue = issuesMap.get(number);
  if (!issue) throw new Error('Issue not found');

  if (issue.state === 'open') {
    issue.state = 'closed';
    issue.closed_at = new Date().toISOString();
    repo.open_issues_count = Math.max(0, repo.open_issues_count - 1);
  }
  issue.updated_at = new Date().toISOString();
  return issue;
}

export function createPullRequest(fullName: string, title: string, body: string | null | undefined, head: string, base: string): PullRequest {
  const repo = globalStore.repos.get(fullName);
  if (!repo) throw new Error('Repository not found');
  const pullsMap = globalStore.getPulls(fullName);
  const refs = globalStore.getRefs(fullName);

  const headSha = refs.get(`refs/heads/${head}`);
  const baseSha = refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) {
    throw new Error('Head or base branch does not exist');
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
  return pull;
}

export function changedFiles(fullName: string, baseSha: string, headSha: string): Array<{ filename: string; path: string; status: string }> {
  const baseCommitObj = globalStore.readObject(fullName, baseSha);
  const headCommitObj = globalStore.readObject(fullName, headSha);
  if (!baseCommitObj || !headCommitObj) return [];

  let baseTree = '';
  let headTree = '';
  for (const line of baseCommitObj.content.toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) baseTree = line.slice(5).trim();
  }
  for (const line of headCommitObj.content.toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) headTree = line.slice(5).trim();
  }

  const baseFiles = globalStore.getFilesMap(fullName, baseTree);
  const headFiles = globalStore.getFilesMap(fullName, headTree);

  const results: Array<{ filename: string; path: string; status: string }> = [];
  const allPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);

  for (const path of allPaths) {
    const baseBlob = baseFiles.get(path);
    const headBlob = headFiles.get(path);
    if (!baseBlob && headBlob) {
      results.push({ filename: path, path, status: 'added' });
    } else if (baseBlob && !headBlob) {
      results.push({ filename: path, path, status: 'removed' });
    } else if (baseBlob && headBlob && baseBlob !== headBlob) {
      results.push({ filename: path, path, status: 'modified' });
    }
  }

  return results;
}

export function mergeableState(fullName: string, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const refs = globalStore.getRefs(fullName);
  const baseRef = pull.base.ref;
  const baseSha = refs.get(`refs/heads/${baseRef}`);
  const headSha = pull.head.sha;
  if (!baseSha || !headSha) return 'UNKNOWN';

  const mergeBaseSha = globalStore.findMergeBase(fullName, baseSha, headSha);
  if (!mergeBaseSha) return 'MERGEABLE';

  const baseCommitObj = globalStore.readObject(fullName, baseSha);
  const headCommitObj = globalStore.readObject(fullName, headSha);
  const mbCommitObj = globalStore.readObject(fullName, mergeBaseSha);

  if (!baseCommitObj || !headCommitObj || !mbCommitObj) return 'UNKNOWN';

  let baseTree = '', headTree = '', mbTree = '';
  for (const line of baseCommitObj.content.toString('utf8').split('\n')) if (line.startsWith('tree ')) baseTree = line.slice(5).trim();
  for (const line of headCommitObj.content.toString('utf8').split('\n')) if (line.startsWith('tree ')) headTree = line.slice(5).trim();
  for (const line of mbCommitObj.content.toString('utf8').split('\n')) if (line.startsWith('tree ')) mbTree = line.slice(5).trim();

  const baseFiles = globalStore.getFilesMap(fullName, baseTree);
  const headFiles = globalStore.getFilesMap(fullName, headTree);
  const mbFiles = globalStore.getFilesMap(fullName, mbTree);

  for (const [path, headBlob] of headFiles) {
    const mbBlob = mbFiles.get(path);
    const baseBlob = baseFiles.get(path);
    if (baseBlob && mbBlob && baseBlob !== mbBlob && headBlob !== baseBlob && headBlob !== mbBlob) {
      return 'CONFLICTING';
    }
  }

  return 'MERGEABLE';
}

export function mergePullRequest(fullName: string, number: number, mergeMethod = 'squash'): { sha: string; merged: true; message: string } {
  const repo = globalStore.repos.get(fullName);
  if (!repo) throw new Error('Repository not found');
  const pullsMap = globalStore.getPulls(fullName);
  const refs = globalStore.getRefs(fullName);
  const pull = pullsMap.get(number);
  if (!pull) throw new Error('Pull request not found');
  if (pull.merged) throw new Error('Pull request already merged');

  const baseRef = pull.base.ref;
  const baseSha = refs.get(`refs/heads/${baseRef}`);
  const headSha = pull.head.sha;
  if (!baseSha) throw new Error('Base branch ref missing');

  // Conflict check
  const state = mergeableState(fullName, pull);
  if (state === 'CONFLICTING') {
    throw new Error('Merge conflict detected');
  }

  const headCommitObj = globalStore.readObject(fullName, headSha);
  let headTreeSha = '';
  if (headCommitObj && headCommitObj.type === 'commit') {
    for (const line of headCommitObj.content.toString('utf8').split('\n')) {
      if (line.startsWith('tree ')) headTreeSha = line.slice(5).trim();
    }
  }

  const mergeCommitSha = globalStore.writeCommit(fullName, {
    treeSha: headTreeSha,
    parents: [baseSha],
    message: `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${pull.title}`,
  });

  refs.set(`refs/heads/${baseRef}`, mergeCommitSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = new Date().toISOString();
  pull.closed_at = pull.merged_at;
  pull.merge_commit_sha = mergeCommitSha;

  return {
    sha: mergeCommitSha,
    merged: true,
    message: 'Pull request successfully merged',
  };
}

export function addComment(fullName: string, issueNumber: number, body: string): IssueComment {
  const repo = globalStore.repos.get(fullName);
  if (!repo) throw new Error('Repository not found');
  const issuesMap = globalStore.getIssues(fullName);
  const issue = issuesMap.get(issueNumber);
  if (!issue) throw new Error('Issue not found');

  const commentsMap = globalStore.getIssueComments(fullName);
  const commentsList = commentsMap.get(issueNumber) || [];
  const now = new Date().toISOString();
  const comment: IssueComment = {
    id: commentsList.length + 1,
    node_id: `IC_kwD${body.slice(0, 5)}`,
    body,
    user: { login: repo.owner.login },
    created_at: now,
    updated_at: now,
    html_url: `https://github.com/${fullName}/issues/${issueNumber}#issuecomment-${commentsList.length + 1}`,
    url: `https://api.github.com/repos/${fullName}/issues/comments/${commentsList.length + 1}`,
  };
  commentsList.push(comment);
  commentsMap.set(issueNumber, commentsList);
  issue.comments = commentsList.length;
  return comment;
}
