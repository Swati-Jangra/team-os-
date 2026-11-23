export type GitHubErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'SERVER' | 'NETWORK' | 'BAD_RESPONSE';
export class GitHubError extends Error {
  constructor(message: string, readonly code: GitHubErrorCode, readonly status: number | null, readonly retryable: boolean) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubConfig {
  apiUrl: string; // https://api.github.com
  oauthUrl: string; // https://github.com
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type ItemKind = 'PULL_REQUEST' | 'ISSUE' | 'COMMIT';
export interface ExternalItem {
  kind: ItemKind;
  externalId: string; // PR/issue number, or commit sha
  title: string;
  state: 'open' | 'closed' | 'merged' | null;
  url: string;
  authorLogin: string | null;
  headRef: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  mergedAt: string | null;
}
export interface RepoInfo {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Maps GitHub's API/webhook shapes onto one small, stable shape. Bodies are deliberately NOT kept (titles/links only). */
export function normalizePull(p: Json): ExternalItem {
  return {
    kind: 'PULL_REQUEST', externalId: String(p.number), title: String(p.title ?? '').slice(0, 300),
    state: p.merged_at || p.merged ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
    url: String(p.html_url ?? ''), authorLogin: str(p.user?.login), headRef: str(p.head?.ref),
    createdAt: str(p.created_at), updatedAt: str(p.updated_at), mergedAt: str(p.merged_at),
  };
}
export function normalizeIssue(i: Json): ExternalItem {
  return {
    kind: 'ISSUE', externalId: String(i.number), title: String(i.title ?? '').slice(0, 300), state: i.state === 'closed' ? 'closed' : 'open',
    url: String(i.html_url ?? ''), authorLogin: str(i.user?.login), headRef: null, createdAt: str(i.created_at), updatedAt: str(i.updated_at), mergedAt: null,
  };
}
export function normalizeCommit(c: Json): ExternalItem {
  const message = String(c.commit?.message ?? c.message ?? '');
  return {
    kind: 'COMMIT', externalId: String(c.sha ?? c.id), title: message.split('\n')[0]!.slice(0, 300), state: null,
    url: String(c.html_url ?? c.url ?? ''), authorLogin: str(c.author?.login) ?? str(c.commit?.author?.name ?? c.author?.username),
    headRef: null, createdAt: str(c.commit?.author?.date ?? c.timestamp), updatedAt: str(c.commit?.author?.date ?? c.timestamp), mergedAt: null,
  };
}

export class GitHubClient {
  private readonly f: typeof fetch;
  constructor(private readonly cfg: GitHubConfig) {
    this.f = cfg.fetch ?? fetch;
  }

  authorizeUrl(state: string, redirectUri: string, scopes: string[]): string {
    const q = new URLSearchParams({ client_id: this.cfg.clientId, redirect_uri: redirectUri, scope: scopes.join(' '), state, allow_signup: 'false' });
    return `${this.cfg.oauthUrl}/login/oauth/authorize?${q}`;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.f(url, { ...init, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000) });
    } catch (e) {
      throw new GitHubError(`GitHub is unreachable: ${e instanceof Error ? e.message : 'network error'}`, 'NETWORK', null, true);
    }
    if (res.ok) return res;
    const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
    if (limited) throw new GitHubError('GitHub rate limit reached', 'RATE_LIMITED', res.status, true);
    if (res.status === 401) throw new GitHubError('GitHub rejected the access token (revoked or expired)', 'UNAUTHORIZED', 401, false);
    if (res.status === 403) throw new GitHubError('GitHub denied access to this resource', 'FORBIDDEN', 403, false);
    if (res.status === 404) throw new GitHubError('Not found on GitHub (or no access)', 'NOT_FOUND', 404, false);
    if (res.status >= 500) throw new GitHubError(`GitHub error ${res.status}`, 'SERVER', res.status, true);
    throw new GitHubError(`GitHub request failed (${res.status})`, 'BAD_RESPONSE', res.status, false);
  }

  private async api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.send(`${this.cfg.apiUrl}${path}`, {
      ...init,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TeamOS-AI', ...(init.headers ?? {}) },
    });
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new GitHubError('GitHub returned an unreadable response', 'BAD_RESPONSE', res.status, false);
    }
  }

  async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; scope: string }> {
    const res = await this.send(`${this.cfg.oauthUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'TeamOS-AI' },
      body: JSON.stringify({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code, redirect_uri: redirectUri }),
    });
    const j = (await res.json().catch(() => ({}))) as Json;
    if (typeof j.access_token !== 'string' || j.error) throw new GitHubError(`GitHub did not issue a token${j.error ? ` (${String(j.error)})` : ''}`, 'BAD_RESPONSE', res.status, false);
    return { accessToken: j.access_token, scope: String(j.scope ?? '') };
  }

  async getViewer(token: string): Promise<{ id: number; login: string }> {
    const u = await this.api<Json>(token, '/user');
    return { id: Number(u.id), login: String(u.login) };
  }

  async listRepos(token: string): Promise<RepoInfo[]> {
    const r = await this.api<Json[]>(token, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
    return r.map((x) => ({ id: Number(x.id), fullName: String(x.full_name), private: Boolean(x.private), defaultBranch: String(x.default_branch ?? 'main') }));
  }

  async getRepo(token: string, fullName: string): Promise<RepoInfo> {
    assertRepoName(fullName);
    const x = await this.api<Json>(token, `/repos/${fullName}`);
    return { id: Number(x.id), fullName: String(x.full_name), private: Boolean(x.private), defaultBranch: String(x.default_branch ?? 'main') };
  }

  /** Newest-first pages until an item older than `since` is reached (bounded). */
  private async paged(token: string, path: string, since: string | null, maxPages: number, dateOf: (j: Json) => string | null): Promise<Json[]> {
    const out: Json[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.api<Json[]>(token, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      let reachedOld = false;
      for (const j of batch) {
        const d = dateOf(j);
        if (since && d && d < since) { reachedOld = true; continue; }
        out.push(j);
      }
      if (batch.length < 100 || reachedOld) break;
    }
    return out;
  }

  async listPulls(token: string, fullName: string, since: string | null, maxPages = 5): Promise<ExternalItem[]> {
    assertRepoName(fullName);
    return (await this.paged(token, `/repos/${fullName}/pulls?state=all&sort=updated&direction=desc`, since, maxPages, (j) => str(j.updated_at))).map(normalizePull);
  }
  async listIssues(token: string, fullName: string, since: string | null, maxPages = 5): Promise<ExternalItem[]> {
    assertRepoName(fullName);
    const rows = await this.paged(token, `/repos/${fullName}/issues?state=all&sort=updated&direction=desc`, since, maxPages, (j) => str(j.updated_at));
    return rows.filter((j) => !j.pull_request).map(normalizeIssue); // GitHub lists PRs as issues too
  }
  async listCommits(token: string, fullName: string, since: string | null): Promise<ExternalItem[]> {
    assertRepoName(fullName);
    return (await this.paged(token, `/repos/${fullName}/commits${since ? `?since=${encodeURIComponent(since)}` : ''}`, null, 1, () => null)).map(normalizeCommit);
  }

  async createWebhook(token: string, fullName: string, url: string, secret: string): Promise<{ id: number }> {
    assertRepoName(fullName);
    const h = await this.api<Json>(token, `/repos/${fullName}/hooks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'web', active: true, events: ['pull_request', 'issues', 'push'], config: { url, content_type: 'json', secret, insecure_ssl: '0' } }),
    });
    return { id: Number(h.id) };
  }
  async deleteWebhook(token: string, fullName: string, hookId: number): Promise<void> {
    assertRepoName(fullName);
    await this.api<void>(token, `/repos/${fullName}/hooks/${hookId}`, { method: 'DELETE' });
  }
}

/** Repository names go into URL paths: allow only `owner/name` made of GitHub-legal characters. */
export function assertRepoName(fullName: string): void {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(fullName)) throw new GitHubError('Invalid repository name', 'BAD_RESPONSE', null, false);
}
