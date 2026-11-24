/**
 * Saving a copy of a workshop to the server operator's own private GitHub repository.
 *
 * It is a backup, not live storage: the app keeps working from its own database and
 * writes one JSON file per workshop here on request, in the same format the Save tab
 * downloads and the start page imports.
 *
 * The repository is found by name. It is checked first, created (private) only if it
 * does not exist, and never written to if it turns out to be public.
 */
import { execFileSync } from 'node:child_process';
import type { ExportFile } from '../shared/commands';
import { CommandError } from '../shared/types';

export const DEFAULT_BACKUP_REPO = 'backchaining-models';

export interface GithubBackupStatus {
  available: boolean;
  /** Why it is not available, in plain words. */
  reason?: string;
  login?: string;
  repo: string;
  exists?: boolean;
  isPrivate?: boolean;
  url?: string;
}

export interface GithubBackupOptions {
  /** Returns a token, or null when nobody is signed in. Never sent to a browser. */
  token: () => string | null;
  repo?: string;
  fetchImpl?: typeof fetch;
}

/** A token from the environment, or from the GitHub command-line tool if it is signed in. */
export function localToken(): string | null {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'workshop';
}

const readme = (repo: string) => `# ${repo}

Copies of Backchain workshops and models, saved from the app.

**Please do not rename this repository, and keep it private.**

- The app finds this repository by its name (\`${repo}\`). If it is renamed, the app will not find it and will create a new one the next time something is saved.
- The files contain everything people entered, including each participant's answers and reasoning. Making the repository public would publish that.

## What is here

\`workshops/\` holds one JSON file per workshop or solo model. Each file is complete, including its full history. A file is replaced each time that workshop is saved again; earlier versions are in this repository's commit history.

## Getting a model back

Download the file, open the app's start page, choose **Import from a file**, and pick it. That creates a separate copy and does not change anything already in the app.
`;

export function createGithubBackup(options: GithubBackupOptions) {
  const repo = options.repo ?? DEFAULT_BACKUP_REPO;
  const doFetch = options.fetchImpl ?? fetch;

  async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    let response: Response;
    try {
      response = await doFetch(`https://api.github.com${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'backchain', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new CommandError('conflict', 'Could not reach GitHub. Check the internet connection and try again.');
    }
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  }

  async function who(token: string): Promise<string> {
    const me = await call(token, 'GET', '/user');
    if (me.status === 401) throw new CommandError('forbidden', 'The GitHub sign-in on this computer has expired. Sign in again (gh auth login) and retry.');
    if (me.status !== 200 || !me.data.login) throw new CommandError('conflict', 'GitHub did not say who is signed in.');
    return String(me.data.login);
  }

  /** Look only: who is signed in, and whether the repository already exists and is private. */
  async function status(): Promise<GithubBackupStatus> {
    const token = options.token();
    if (!token) return { available: false, repo, reason: 'Nobody is signed in to GitHub on this computer. Sign in with the GitHub command-line tool (gh auth login), or set GITHUB_TOKEN, then try again.' };
    try {
      const login = await who(token);
      const found = await call(token, 'GET', `/repos/${login}/${repo}`);
      if (found.status === 404) return { available: true, repo, login, exists: false };
      if (found.status !== 200) return { available: false, repo, login, reason: 'GitHub would not show that repository. The sign-in may lack permission for repositories.' };
      const isPrivate = found.data.private === true;
      return {
        available: isPrivate,
        repo,
        login,
        exists: true,
        isPrivate,
        url: String(found.data.html_url ?? ''),
        reason: isPrivate ? undefined : `A repository called ${repo} already exists on this account and is public. Nothing will be saved to it. Make it private on GitHub, then try again.`,
      };
    } catch (err) {
      return { available: false, repo, reason: (err as Error).message };
    }
  }

  /** Save one workshop. Checks for the repository first; creates it, private, only if it is missing. */
  async function save(file: ExportFile, workshopId: string): Promise<{ url: string; created: boolean; path: string }> {
    const token = options.token();
    if (!token) throw new CommandError('conflict', 'Nobody is signed in to GitHub on this computer.');
    const login = await who(token);
    const base = `/repos/${login}/${repo}`;
    let created = false;
    let found = await call(token, 'GET', base);
    if (found.status === 404) {
      const made = await call(token, 'POST', '/user/repos', { name: repo, private: true, description: 'Private copies of Backchain workshops and models. Please do not rename.', has_issues: false, has_wiki: false, auto_init: false });
      if (made.status !== 201) throw new CommandError('conflict', `GitHub would not create the repository: ${made.data.message ?? made.status}`);
      found = made;
      created = true;
    } else if (found.status !== 200) {
      throw new CommandError('conflict', `GitHub would not show the repository: ${found.data.message ?? found.status}`);
    }
    // Never write people's answers anywhere public, whatever the name says.
    if (found.data.private !== true) throw new CommandError('conflict', `The repository ${login}/${repo} is public, so nothing was saved. Make it private on GitHub, then try again.`);

    const put = async (path: string, text: string, message: string) => {
      const existing = await call(token, 'GET', `${base}/contents/${path}`);
      const sha = existing.status === 200 ? existing.data.sha : undefined;
      const result = await call(token, 'PUT', `${base}/contents/${path}`, { message, content: Buffer.from(text, 'utf8').toString('base64'), ...(sha ? { sha } : {}) });
      if (result.status !== 200 && result.status !== 201) throw new CommandError('conflict', `GitHub would not save the file: ${result.data.message ?? result.status}`);
    };
    const hasReadme = await call(token, 'GET', `${base}/contents/README.md`);
    if (hasReadme.status === 404) await put('README.md', readme(repo), 'Explain what this repository is');

    // One file per workshop. The id keeps it the same file if the workshop is renamed.
    const listing = await call(token, 'GET', `${base}/contents/workshops`);
    const previous = Array.isArray(listing.data) ? listing.data.find((f: { name?: string }) => typeof f.name === 'string' && f.name.endsWith(`--${workshopId}.json`)) : undefined;
    const path = previous ? `workshops/${previous.name}` : `workshops/${slug(file.title)}--${workshopId}.json`;
    await put(path, JSON.stringify(file, null, 1) + '\n', `Save “${file.title}” (${file.events.length} changes)`);
    return { url: `https://github.com/${login}/${repo}/blob/HEAD/${path}`, created, path };
  }

  return { status, save, repo };
}

export type GithubBackup = ReturnType<typeof createGithubBackup>;
