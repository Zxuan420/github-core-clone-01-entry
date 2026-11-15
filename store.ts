import { createHash } from 'node:crypto';

export interface User {
  login: string;
  id: number;
  type: string;
}

export interface Repository {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: User;
  private: boolean;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  html_url: string;
  url: string;
  clone_url: string;
  git_url: string;
  ssh_url: string;
  fork: boolean;
  has_issues: boolean;
  has_projects: boolean;
  has_wiki: boolean;
  size: number;
  open_issues_count: number;
  watchers_count: number;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  topics: string[];
  visibility: string;
}

export interface Label {
  id: number;
  node_id: string;
  name: string;
  color: string;
  default: boolean;
  description: string | null;
}

export interface Issue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Label[];
  user: { login: string };
  assignee: null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  url: string;
  repository_url: string;
  comments: number;
  locked: boolean;
}

export interface IssueComment {
  id: number;
  node_id: string;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  url: string;
}

export interface PullRequest {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  locked: boolean;
  head: {
    label: string;
    ref: string;
    sha: string;
    repo: Repository;
  };
  base: {
    label: string;
    ref: string;
    sha: string;
    repo: Repository;
  };
  merged: boolean;
  mergeable: boolean;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  user: { login: string };
  html_url: string;
  url: string;
  draft: boolean;
}

export interface CommitObject {
  sha: string;
  node_id: string;
  commit: {
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
    message: string;
    tree: { sha: string };
  };
  author: null;
  committer: null;
  parents: Array<{ sha: string }>;
  html_url: string;
  url: string;
}

export interface TreeEntry {
  mode: string; // '100644' or '040000'
  name: string;
  sha: string;   // 40-char hex
  type: 'blob' | 'tree';
}

export class RepoStore {
  repos = new Map<string, Repository>(); // full_name -> Repository
  repoObjects = new Map<string, Map<string, Buffer>>(); // full_name -> (sha -> rawObjectBuffer)
  repoRefs = new Map<string, Map<string, string>>(); // full_name -> (refName -> sha)
  repoIssues = new Map<string, Map<number, Issue>>(); // full_name -> (number -> Issue)
  repoIssueComments = new Map<string, Map<number, IssueComment[]>>(); // full_name -> (issueNumber -> comments[])
  repoPulls = new Map<string, Map<number, PullRequest>>(); // full_name -> (number -> PullRequest)
  repoLabels = new Map<string, Map<string, Label>>(); // full_name -> (labelName -> Label)
  
  issueCounter = 1;
  pullCounter = 1;
  repoIdCounter = 1000;

  getObjects(fullName: string): Map<string, Buffer> {
    let objs = this.repoObjects.get(fullName);
    if (!objs) {
      objs = new Map();
      this.repoObjects.set(fullName, objs);
    }
    return objs;
  }

  getRefs(fullName: string): Map<string, string> {
    let refs = this.repoRefs.get(fullName);
    if (!refs) {
      refs = new Map();
      this.repoRefs.set(fullName, refs);
    }
    return refs;
  }

  getIssues(fullName: string): Map<number, Issue> {
    let issues = this.repoIssues.get(fullName);
    if (!issues) {
      issues = new Map();
      this.repoIssues.set(fullName, issues);
    }
    return issues;
  }

  getIssueComments(fullName: string): Map<number, IssueComment[]> {
    let comments = this.repoIssueComments.get(fullName);
    if (!comments) {
      comments = new Map();
      this.repoIssueComments.set(fullName, comments);
    }
    return comments;
  }

  getPulls(fullName: string): Map<number, PullRequest> {
    let pulls = this.repoPulls.get(fullName);
    if (!pulls) {
      pulls = new Map();
      this.repoPulls.set(fullName, pulls);
    }
    return pulls;
  }

  getLabels(fullName: string): Map<string, Label> {
    let labels = this.repoLabels.get(fullName);
    if (!labels) {
      labels = new Map();
      this.repoLabels.set(fullName, labels);
    }
    return labels;
  }

  // Git Object Store methods
  writeRawObject(fullName: string, type: 'blob' | 'tree' | 'commit', content: Buffer): string {
    const header = Buffer.from(`${type} ${content.length}\0`);
    const fullBuffer = Buffer.concat([header, content]);
    const sha = createHash('sha1').update(fullBuffer).digest('hex');
    this.getObjects(fullName).set(sha, fullBuffer);
    return sha;
  }

  readObject(fullName: string, sha: string): { type: string; content: Buffer } | null {
    const raw = this.getObjects(fullName).get(sha);
    if (!raw) return null;
    const nullIdx = raw.indexOf(0);
    if (nullIdx === -1) return null;
    const headerStr = raw.subarray(0, nullIdx).toString('utf8');
    const type = headerStr.split(' ')[0] ?? '';
    const content = raw.subarray(nullIdx + 1);
    return { type, content };
  }

  writeBlob(fullName: string, contentBuffer: Buffer): string {
    return this.writeRawObject(fullName, 'blob', contentBuffer);
  }

  writeTree(fullName: string, entries: TreeEntry[]): string {
    // Sort entries by name (directories have '/' appended conceptually or sorted correctly)
    const sorted = [...entries].sort((a, b) => {
      const nameA = a.type === 'tree' ? a.name + '/' : a.name;
      const nameB = b.type === 'tree' ? b.name + '/' : b.name;
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    });

    const buffers: Buffer[] = [];
    for (const entry of sorted) {
      const modeName = `${entry.mode} ${entry.name}\0`;
      const shaBytes = Buffer.from(entry.sha, 'hex'); // 20 bytes binary sha1
      buffers.push(Buffer.from(modeName, 'utf8'));
      buffers.push(shaBytes);
    }
    const treeContent = Buffer.concat(buffers);
    return this.writeRawObject(fullName, 'tree', treeContent);
  }

  writeCommit(fullName: string, opts: {
    treeSha: string;
    parents: string[];
    message: string;
    authorName?: string;
    authorEmail?: string;
    committerName?: string;
    committerEmail?: string;
    date?: string;
  }): string {
    const dateStr = opts.date || new Date().toISOString();
    const authorName = opts.authorName || 'forge';
    const authorEmail = opts.authorEmail || 'forge@localhost';
    const committerName = opts.committerName || authorName;
    const committerEmail = opts.committerEmail || authorEmail;
    
    // Parse timestamp and timezone (e.g. 1700000000 +0000)
    const epoch = Math.floor(new Date(dateStr).getTime() / 1000);
    const timeFormatted = `${isNaN(epoch) ? Math.floor(Date.now() / 1000) : epoch} +0000`;

    let content = `tree ${opts.treeSha}\n`;
    for (const p of opts.parents) {
      content += `parent ${p}\n`;
    }
    content += `author ${authorName} <${authorEmail}> ${timeFormatted}\n`;
    content += `committer ${committerName} <${committerEmail}> ${timeFormatted}\n\n`;
    content += `${opts.message.endsWith('\n') ? opts.message : opts.message + '\n'}`;

    return this.writeRawObject(fullName, 'commit', Buffer.from(content, 'utf8'));
  }

  parseTree(fullName: string, treeSha: string): TreeEntry[] {
    const obj = this.readObject(fullName, treeSha);
    if (!obj || obj.type !== 'tree') return [];
    const buf = obj.content;
    const entries: TreeEntry[] = [];
    let offset = 0;
    while (offset < buf.length) {
      const spaceIdx = buf.indexOf(32, offset); // space ascii 32
      if (spaceIdx === -1) break;
      const mode = buf.subarray(offset, spaceIdx).toString('utf8');
      const nullIdx = buf.indexOf(0, spaceIdx);
      if (nullIdx === -1) break;
      const name = buf.subarray(spaceIdx + 1, nullIdx).toString('utf8');
      const shaBytes = buf.subarray(nullIdx + 1, nullIdx + 21);
      if (shaBytes.length < 20) break;
      const sha = shaBytes.toString('hex');
      const type = mode === '040000' ? 'tree' : 'blob';
      entries.push({ mode, name, sha, type });
      offset = nullIdx + 21;
    }
    return entries;
  }

  // Get file content recursively or path resolution
  getFileAtPath(fullName: string, treeSha: string, pathParts: string[]): { sha: string; content: Buffer } | null {
    if (pathParts.length === 0) return null;
    const [current, ...rest] = pathParts;
    const entries = this.parseTree(fullName, treeSha);
    const found = entries.find(e => e.name === current);
    if (!found) return null;
    if (rest.length === 0) {
      if (found.type === 'blob') {
        const obj = this.readObject(fullName, found.sha);
        return obj ? { sha: found.sha, content: obj.content } : null;
      }
      return null;
    } else {
      if (found.type === 'tree') {
        return this.getFileAtPath(fullName, found.sha, rest);
      }
      return null;
    }
  }

  // Update or insert a file in a tree, returning the new root tree sha
  updateTreeAtPath(fullName: string, currentTreeSha: string, pathParts: string[], newBlobSha: string | null): string {
    const [current, ...rest] = pathParts;
    const entries = this.parseTree(fullName, currentTreeSha);
    const existingIndex = entries.findIndex(e => e.name === current);

    if (rest.length === 0) {
      // Leaf node (file)
      if (newBlobSha === null) {
        // Delete
        if (existingIndex !== -1) {
          entries.splice(existingIndex, 1);
        }
      } else {
        // Upsert
        if (existingIndex !== -1) {
          const entry = entries[existingIndex];
          if (entry) {
            entry.sha = newBlobSha;
            entry.mode = '100644';
          }
        } else {
          entries.push({ mode: '100644', name: current!, sha: newBlobSha, type: 'blob' });
        }
      }
    } else {
      // Intermediate node (directory)
      let subTreeSha = '0'.repeat(40);
      let subEntries: TreeEntry[] = [];
      if (existingIndex !== -1) {
        const entry = entries[existingIndex];
        if (entry && entry.type === 'tree') {
          subTreeSha = entry.sha;
          subEntries = this.parseTree(fullName, subTreeSha);
        }
      }
      const updatedSubTreeSha = this.updateTreeAtPath(fullName, subTreeSha, rest, newBlobSha);
      if (existingIndex !== -1) {
        const entry = entries[existingIndex];
        if (entry) {
          entry.sha = updatedSubTreeSha;
          entry.type = 'tree';
          entry.mode = '040000';
        }
      } else {
        entries.push({ mode: '040000', name: current!, sha: updatedSubTreeSha, type: 'tree' });
      }
    }
    return this.writeTree(fullName, entries);
  }

  // Get full file tree map (path -> {sha, content}) for merge check
  getFilesMap(fullName: string, treeSha: string, prefix = ''): Map<string, string> {
    const map = new Map<string, string>(); // path -> blobSha
    const entries = this.parseTree(fullName, treeSha);
    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'blob') {
        map.set(fullPath, entry.sha);
      } else if (entry.type === 'tree') {
        const sub = this.getFilesMap(fullName, entry.sha, fullPath);
        for (const [k, v] of sub) {
          map.set(k, v);
        }
      }
    }
    return map;
  }

  findMergeBase(fullName: string, commitA: string, commitB: string): string | null {
    // Simple ancestor search (find latest common ancestor)
    const ancestorsA = new Set<string>();
    const queueA = [commitA];
    const visitedA = new Set<string>();
    while (queueA.length > 0) {
      const sha = queueA.shift()!;
      if (visitedA.has(sha)) continue;
      visitedA.add(sha);
      ancestorsA.add(sha);
      const commitObj = this.readObject(fullName, sha);
      if (commitObj && commitObj.type === 'commit') {
        const text = commitObj.content.toString('utf8');
        for (const line of text.split('\n')) {
          if (line.startsWith('parent ')) {
            queueA.push(line.slice(7).trim());
          }
        }
      }
    }

    const queueB = [commitB];
    const visitedB = new Set<string>();
    while (queueB.length > 0) {
      const sha = queueB.shift()!;
      if (visitedB.has(sha)) continue;
      visitedB.add(sha);
      if (ancestorsA.has(sha)) return sha;
      const commitObj = this.readObject(fullName, sha);
      if (commitObj && commitObj.type === 'commit') {
        const text = commitObj.content.toString('utf8');
        for (const line of text.split('\n')) {
          if (line.startsWith('parent ')) {
            queueB.push(line.slice(7).trim());
          }
        }
      }
    }
    return null;
  }
}

export const globalStore = new RepoStore();
