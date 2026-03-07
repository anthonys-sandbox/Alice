import { createLogger } from '../utils/logger.js';

const log = createLogger('GitHubIntegration');

/**
 * GitHub API integration using personal access token.
 * Set GITHUB_TOKEN env var.
 */
async function ghFetch(path: string, opts: RequestInit = {}): Promise<any> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN not set. Set it in .env to use GitHub integration.');

    const res = await fetch(`https://api.github.com${path}`, {
        ...opts,
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
    }

    return res.json();
}

export async function listRepos(owner?: string): Promise<string> {
    const path = owner ? `/users/${owner}/repos?per_page=20&sort=updated` : '/user/repos?per_page=20&sort=updated';
    const repos = await ghFetch(path);
    return repos.map((r: any) =>
        `${r.full_name} — ⭐${r.stargazers_count} | ${r.language || 'n/a'} | updated ${r.updated_at?.split('T')[0]}`
    ).join('\n');
}

export async function listIssues(repo: string, state: string = 'open'): Promise<string> {
    const issues = await ghFetch(`/repos/${repo}/issues?state=${state}&per_page=20`);
    return issues.map((i: any) =>
        `#${i.number} ${i.title} [${i.state}] — by ${i.user?.login} (${i.labels?.map((l: any) => l.name).join(', ') || 'no labels'})`
    ).join('\n');
}

export async function createIssue(repo: string, title: string, body: string, labels?: string[]): Promise<string> {
    const issue = await ghFetch(`/repos/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title, body, labels: labels || [] }),
    });
    return `Created issue #${issue.number}: ${issue.title}\nURL: ${issue.html_url}`;
}

export async function listPRs(repo: string, state: string = 'open'): Promise<string> {
    const prs = await ghFetch(`/repos/${repo}/pulls?state=${state}&per_page=20`);
    return prs.map((pr: any) =>
        `#${pr.number} ${pr.title} [${pr.state}] — ${pr.head?.ref} → ${pr.base?.ref} by ${pr.user?.login}`
    ).join('\n');
}

export async function searchCode(query: string): Promise<string> {
    const results = await ghFetch(`/search/code?q=${encodeURIComponent(query)}&per_page=10`);
    return results.items?.map((i: any) =>
        `${i.repository?.full_name}/${i.path} — ${i.html_url}`
    ).join('\n') || 'No results';
}
