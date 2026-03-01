/**
 * GravityClaw Integration Tools
 *
 * Bridges Alice to GravityClaw's SQLite memory database and connected services:
 * - gc_memory_query  — search/read from GravityClaw SQLite
 * - gc_memory_save   — write key/value to GravityClaw SQLite
 * - gc_todoist       — Todoist task management
 * - gc_jira          — JIRA issue search and actions
 * - gc_gmail_read    — Gmail message reading
 * - gc_github        — GitHub repo status and commits
 *
 * All tools are auto-registered in Alice's tool registry on import.
 */

import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import { registerTool } from '../runtime/tools/registry.js';

const log = createLogger('GCTools');

// ─── Helpers ────────────────────────────────────────────────────────────────

function getGravityClawDb() {
    // Try env override first, then resolve relative to alice dir
    const envPath = process.env.GRAVITYCLAW_DB_PATH;
    const candidates = [
        envPath ? resolve(envPath) : null,
        resolve('../data/gravity-claw.db'),
        resolve('../../data/gravity-claw.db'),
        join(process.cwd(), '..', 'data', 'gravity-claw.db'),
    ].filter(Boolean) as string[];

    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    return null;
}

/**
 * Write a key/value fact to the GravityClaw SQLite core_memory table.
 * Returns true on success. Exported so agent.ts can bridge auto-learned facts.
 */
export async function saveToGcDb(key: string, value: string): Promise<boolean> {
    const dbPath = getGravityClawDb();
    if (!dbPath) return false;
    try {
        const { default: Database } = await import('better-sqlite3');
        const db = new Database(dbPath);
        // Ensure both the legacy memories table and core_memory exist
        db.exec(`CREATE TABLE IF NOT EXISTS core_memory (
            key        TEXT    PRIMARY KEY,
            value      TEXT    NOT NULL,
            updated_at INTEGER NOT NULL
        )`);
        const sanitizedKey = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80);
        db.prepare(
            `INSERT OR REPLACE INTO core_memory (key, value, updated_at) VALUES (?, ?, ?)`
        ).run(sanitizedKey, value.trim(), Date.now());
        db.close();
        return true;
    } catch (err: any) {
        log.warn('saveToGcDb failed', { error: err.message });
        return false;
    }
}


// ─── gc_memory_query ────────────────────────────────────────────────────────

registerTool({
    name: 'gc_memory_query',
    description: 'Search and read memories from the GravityClaw SQLite database. Use this to recall facts, context, or notes previously stored by the GravityClaw agent.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Search term to filter memories. Leave empty to get all recent memories.',
            },
            limit: {
                type: 'integer',
                description: 'Maximum number of results (default: 20)',
            },
        },
        required: [],
    },
    execute: async (args) => {
        const dbPath = getGravityClawDb();
        if (!dbPath) {
            return '⚠️ GravityClaw database not found. Expected at ../data/gravity-claw.db';
        }

        try {
            const { default: Database } = await import('better-sqlite3');
            const db = new Database(dbPath, { readonly: true });
            const limit = args.limit ?? 20;
            const q = args.query?.trim();

            let rows: any[];
            if (q) {
                rows = db.prepare(
                    `SELECT key, value, created_at FROM memories
                     WHERE key LIKE ? OR value LIKE ?
                     ORDER BY created_at DESC LIMIT ?`
                ).all(`%${q}%`, `%${q}%`, limit);
            } else {
                rows = db.prepare(
                    `SELECT key, value, created_at FROM memories
                     ORDER BY created_at DESC LIMIT ?`
                ).all(limit);
            }
            db.close();

            if (rows.length === 0) {
                return q ? `No memories found matching "${q}".` : 'No memories stored yet.';
            }

            const lines = rows.map((r: any) =>
                `- **${r.key}** (${r.created_at?.slice(0, 10) ?? 'unknown'}): ${r.value}`
            );
            return `**GravityClaw Memories${q ? ` matching "${q}"` : ''}** (${rows.length} results):\n\n${lines.join('\n')}`;
        } catch (err: any) {
            log.error('gc_memory_query failed', { error: err.message });
            return `Error querying GravityClaw database: ${err.message}`;
        }
    },
});

// ─── gc_memory_save ─────────────────────────────────────────────────────────

registerTool({
    name: 'gc_memory_save',
    description: 'Save a memory to the GravityClaw SQLite database. Use this to persist important facts, decisions, or context that should be accessible across both Alice and GravityClaw.',
    parameters: {
        type: 'object',
        properties: {
            key: {
                type: 'string',
                description: 'A short identifier (snake_case). Existing key will be updated.',
            },
            value: {
                type: 'string',
                description: 'The content to store.',
            },
        },
        required: ['key', 'value'],
    },
    execute: async (args) => {
        const dbPath = getGravityClawDb();
        if (!dbPath) {
            return '⚠️ GravityClaw database not found. Expected at ../data/gravity-claw.db';
        }

        try {
            const { default: Database } = await import('better-sqlite3');
            const db = new Database(dbPath);
            const key = args.key.trim().toLowerCase().replace(/\s+/g, '_');
            const value = args.value.trim();

            db.prepare(
                `INSERT INTO memories (key, value, created_at)
                 VALUES (?, ?, datetime('now'))
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value, created_at=excluded.created_at`
            ).run(key, value);
            db.close();

            log.info('gc_memory_save', { key });
            return `✅ Memory saved: **${key}** = "${value.slice(0, 100)}${value.length > 100 ? '…' : ''}"`;
        } catch (err: any) {
            log.error('gc_memory_save failed', { error: err.message });
            return `Error saving memory: ${err.message}`;
        }
    },
});

// ─── gc_todoist ─────────────────────────────────────────────────────────────

registerTool({
    name: 'gc_todoist',
    description: 'Interact with Todoist tasks. Actions: list (get active tasks), add (create a task), complete (mark a task done), projects (list projects).',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'add', 'complete', 'projects'],
                description: 'What to do: list tasks, add a task, complete a task, or list projects',
            },
            content: {
                type: 'string',
                description: 'Task content (required for action=add)',
            },
            task_id: {
                type: 'string',
                description: 'Task ID to complete (required for action=complete)',
            },
            project_id: {
                type: 'string',
                description: 'Filter by project ID (optional for action=list)',
            },
            due_string: {
                type: 'string',
                description: 'Natural language due date (e.g. "tomorrow", "next monday") for action=add',
            },
        },
        required: ['action'],
    },
    execute: async (args) => {
        const apiKey = process.env.TODOIST_API_KEY;
        if (!apiKey) return '⚠️ TODOIST_API_KEY not set in environment.';

        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        };
        const base = 'https://api.todoist.com/rest/v2';

        try {
            switch (args.action) {
                case 'list': {
                    const url = args.project_id
                        ? `${base}/tasks?project_id=${args.project_id}`
                        : `${base}/tasks`;
                    const res = await fetch(url, { headers });
                    if (!res.ok) return `Todoist API error: ${res.status} ${res.statusText}`;
                    const tasks: any[] = await res.json();
                    if (tasks.length === 0) return 'No active tasks found.';
                    const lines = tasks.slice(0, 30).map((t: any) =>
                        `- [${t.id}] ${t.content}${t.due ? ` (due: ${t.due.string})` : ''}`
                    );
                    return `**Todoist Tasks** (${tasks.length} total):\n\n${lines.join('\n')}`;
                }
                case 'add': {
                    if (!args.content) return 'Error: content is required for action=add';
                    const body: any = { content: args.content };
                    if (args.project_id) body.project_id = args.project_id;
                    if (args.due_string) body.due_string = args.due_string;
                    const res = await fetch(`${base}/tasks`, { method: 'POST', headers, body: JSON.stringify(body) });
                    if (!res.ok) return `Todoist API error: ${res.status} ${res.statusText}`;
                    const task: any = await res.json();
                    return `✅ Task created: "${task.content}" (ID: ${task.id})${task.due ? ` — due ${task.due.string}` : ''}`;
                }
                case 'complete': {
                    if (!args.task_id) return 'Error: task_id is required for action=complete';
                    const res = await fetch(`${base}/tasks/${args.task_id}/close`, { method: 'POST', headers });
                    if (!res.ok) return `Todoist API error: ${res.status} ${res.statusText}`;
                    return `✅ Task ${args.task_id} marked as complete.`;
                }
                case 'projects': {
                    const res = await fetch(`${base}/projects`, { headers });
                    if (!res.ok) return `Todoist API error: ${res.status} ${res.statusText}`;
                    const projects: any[] = await res.json();
                    const lines = projects.map((p: any) => `- [${p.id}] ${p.name}`);
                    return `**Todoist Projects** (${projects.length}):\n\n${lines.join('\n')}`;
                }
                default:
                    return `Unknown action: ${args.action}. Use: list, add, complete, or projects`;
            }
        } catch (err: any) {
            log.error('gc_todoist failed', { error: err.message });
            return `Error calling Todoist API: ${err.message}`;
        }
    },
});

// ─── gc_jira ────────────────────────────────────────────────────────────────

registerTool({
    name: 'gc_jira',
    description: 'Interact with JIRA. Actions: search (JQL query), get (single issue), comment (add a comment), my_issues (assigned to me), projects (list projects).',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['search', 'get', 'comment', 'my_issues', 'projects'],
                description: 'What to do: search JQL, get single issue, add comment, list my issues, or list projects',
            },
            jql: {
                type: 'string',
                description: 'JQL query string (for action=search)',
            },
            issue_key: {
                type: 'string',
                description: 'JIRA issue key e.g. "PROJ-123" (for action=get or comment)',
            },
            comment: {
                type: 'string',
                description: 'Comment text (for action=comment)',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum results to return (default: 20)',
            },
        },
        required: ['action'],
    },
    execute: async (args) => {
        const baseUrl = process.env.JIRA_BASE_URL;
        const email = process.env.JIRA_USER_EMAIL;
        const token = process.env.JIRA_API_TOKEN;
        if (!baseUrl || !email || !token) {
            return '⚠️ JIRA not configured. Set JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN in .env';
        }

        const auth = Buffer.from(`${email}:${token}`).toString('base64');
        const headers = {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        const max = args.max_results ?? 20;

        try {
            switch (args.action) {
                case 'search': {
                    if (!args.jql) return 'Error: jql is required for action=search';
                    const url = `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(args.jql)}&maxResults=${max}&fields=summary,status,assignee,priority,created,updated`;
                    const res = await fetch(url, { headers });
                    if (!res.ok) return `JIRA API error: ${res.status} ${await res.text()}`;
                    const data: any = await res.json();
                    if (!data.issues?.length) return 'No issues found for that query.';
                    const lines = data.issues.map((i: any) =>
                        `- **${i.key}** [${i.fields.status?.name}] ${i.fields.summary} — ${i.fields.assignee?.displayName ?? 'Unassigned'}`
                    );
                    return `**JIRA Issues** (${data.total} total, showing ${data.issues.length}):\n\n${lines.join('\n')}`;
                }
                case 'get': {
                    if (!args.issue_key) return 'Error: issue_key is required for action=get';
                    const url = `${baseUrl}/rest/api/3/issue/${args.issue_key}`;
                    const res = await fetch(url, { headers });
                    if (!res.ok) return `JIRA API error: ${res.status} ${await res.text()}`;
                    const issue: any = await res.json();
                    const f = issue.fields;
                    return [
                        `**${issue.key}**: ${f.summary}`,
                        `Status: ${f.status?.name} | Priority: ${f.priority?.name}`,
                        `Assignee: ${f.assignee?.displayName ?? 'Unassigned'}`,
                        `Created: ${f.created?.slice(0, 10)} | Updated: ${f.updated?.slice(0, 10)}`,
                        f.description ? `\nDescription: ${JSON.stringify(f.description).slice(0, 500)}` : '',
                    ].filter(Boolean).join('\n');
                }
                case 'comment': {
                    if (!args.issue_key || !args.comment) return 'Error: issue_key and comment are required';
                    const url = `${baseUrl}/rest/api/3/issue/${args.issue_key}/comment`;
                    const body = {
                        body: {
                            type: 'doc', version: 1,
                            content: [{ type: 'paragraph', content: [{ type: 'text', text: args.comment }] }],
                        },
                    };
                    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
                    if (!res.ok) return `JIRA API error: ${res.status} ${await res.text()}`;
                    return `✅ Comment added to ${args.issue_key}.`;
                }
                case 'my_issues': {
                    const jql = `assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC`;
                    const url = `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=summary,status,priority,updated`;
                    const res = await fetch(url, { headers });
                    if (!res.ok) return `JIRA API error: ${res.status} ${await res.text()}`;
                    const data: any = await res.json();
                    if (!data.issues?.length) return 'No open issues assigned to you.';
                    const lines = data.issues.map((i: any) =>
                        `- **${i.key}** [${i.fields.status?.name}] ${i.fields.summary}`
                    );
                    return `**My Open JIRA Issues** (${data.total} total):\n\n${lines.join('\n')}`;
                }
                case 'projects': {
                    const url = `${baseUrl}/rest/api/3/project?maxResults=50`;
                    const res = await fetch(url, { headers });
                    if (!res.ok) return `JIRA API error: ${res.status} ${await res.text()}`;
                    const projects: any[] = await res.json();
                    const lines = projects.map((p: any) => `- **${p.key}** — ${p.name}`);
                    return `**JIRA Projects** (${projects.length}):\n\n${lines.join('\n')}`;
                }
                default:
                    return `Unknown action: ${args.action}`;
            }
        } catch (err: any) {
            log.error('gc_jira failed', { error: err.message });
            return `Error calling JIRA API: ${err.message}`;
        }
    },
});

// ─── gc_gmail_read ───────────────────────────────────────────────────────────

registerTool({
    name: 'gc_gmail_read',
    description: 'Read Gmail messages. Actions: list (recent emails), get (read a specific email), search (search by query).',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'get', 'search'],
                description: 'What to do: list recent emails, get a specific email, or search',
            },
            message_id: {
                type: 'string',
                description: 'Gmail message ID (for action=get)',
            },
            query: {
                type: 'string',
                description: 'Gmail search query e.g. "from:boss@example.com subject:urgent" (for action=search)',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum emails to return (default: 10)',
            },
        },
        required: ['action'],
    },
    execute: async (args) => {
        const clientId = process.env.GMAIL_CLIENT_ID;
        const clientSecret = process.env.GMAIL_CLIENT_SECRET;
        const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

        if (!clientId || !clientSecret || !refreshToken) {
            return '⚠️ Gmail not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in .env';
        }

        // Get access token using refresh token
        async function getAccessToken(): Promise<string> {
            const res = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: clientId!,
                    client_secret: clientSecret!,
                    refresh_token: refreshToken!,
                    grant_type: 'refresh_token',
                }),
            });
            const data: any = await res.json();
            if (!data.access_token) throw new Error(`Failed to get Gmail token: ${JSON.stringify(data)}`);
            return data.access_token;
        }

        function decodeBody(payload: any): string {
            const findPart = (p: any): string => {
                if (p.body?.data) {
                    const decoded = Buffer.from(p.body.data, 'base64url').toString('utf-8');
                    return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                }
                if (p.parts) {
                    for (const part of p.parts) {
                        const text = findPart(part);
                        if (text) return text;
                    }
                }
                return '';
            };
            return findPart(payload).slice(0, 1000);
        }

        try {
            const accessToken = await getAccessToken();
            const gmailHeaders = { 'Authorization': `Bearer ${accessToken}` };
            const max = args.max_results ?? 10;
            const gmailBase = 'https://gmail.googleapis.com/gmail/v1/users/me';

            switch (args.action) {
                case 'list':
                case 'search': {
                    const q = args.action === 'search' ? (args.query || '') : 'in:inbox';
                    const listUrl = `${gmailBase}/messages?q=${encodeURIComponent(q)}&maxResults=${max}`;
                    const listRes = await fetch(listUrl, { headers: gmailHeaders });
                    if (!listRes.ok) return `Gmail API error: ${listRes.status}`;
                    const listData: any = await listRes.json();
                    const messages = listData.messages || [];
                    if (!messages.length) return 'No emails found.';

                    const details = await Promise.all(
                        messages.slice(0, max).map(async (m: any) => {
                            const mRes = await fetch(`${gmailBase}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, { headers: gmailHeaders });
                            const mData: any = await mRes.json();
                            const headers = mData.payload?.headers || [];
                            const getH = (name: string) => headers.find((h: any) => h.name === name)?.value ?? '';
                            return `- [${m.id}] **${getH('Subject') || '(no subject)'}**\n  From: ${getH('From')} | ${getH('Date')?.slice(0, 16)}`;
                        })
                    );
                    return `**Gmail${args.action === 'search' ? ` search: "${args.query}"` : ' Inbox'}** (${listData.resultSizeEstimate ?? messages.length} results):\n\n${details.join('\n')}`;
                }
                case 'get': {
                    if (!args.message_id) return 'Error: message_id is required for action=get';
                    const mRes = await fetch(`${gmailBase}/messages/${args.message_id}`, { headers: gmailHeaders });
                    if (!mRes.ok) return `Gmail API error: ${mRes.status}`;
                    const mData: any = await mRes.json();
                    const headers = mData.payload?.headers || [];
                    const getH = (name: string) => headers.find((h: any) => h.name === name)?.value ?? '';
                    const body = decodeBody(mData.payload);
                    return [
                        `**Subject**: ${getH('Subject')}`,
                        `**From**: ${getH('From')}`,
                        `**Date**: ${getH('Date')}`,
                        `\n${body || '(no readable body)'}`,
                    ].join('\n');
                }
                default:
                    return `Unknown action: ${args.action}`;
            }
        } catch (err: any) {
            log.error('gc_gmail_read failed', { error: err.message });
            return `Error reading Gmail: ${err.message}`;
        }
    },
});

// ─── gc_github ───────────────────────────────────────────────────────────────

registerTool({
    name: 'gc_github',
    description: 'Interact with GitHub. Actions: repos (list repos), commits (recent commits for a repo), issues (list open issues), prs (list open pull requests).',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['repos', 'commits', 'issues', 'prs'],
                description: 'What to do',
            },
            repo: {
                type: 'string',
                description: 'Repository in "owner/repo" format (required for commits, issues, prs)',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum items to return (default: 10)',
            },
        },
        required: ['action'],
    },
    execute: async (args) => {
        const token = process.env.GITHUB_TOKEN;
        if (!token) return '⚠️ GITHUB_TOKEN not set in environment.';

        const headers = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
        const max = args.max_results ?? 10;
        const ghBase = 'https://api.github.com';

        try {
            switch (args.action) {
                case 'repos': {
                    const res = await fetch(`${ghBase}/user/repos?sort=updated&per_page=${max}`, { headers });
                    if (!res.ok) return `GitHub API error: ${res.status}`;
                    const repos: any[] = await res.json();
                    const lines = repos.map((r: any) =>
                        `- **${r.full_name}** — ${r.description ?? 'no description'} (${r.language ?? 'unknown'}, ${r.open_issues_count} issues)`
                    );
                    return `**GitHub Repos** (${repos.length}):\n\n${lines.join('\n')}`;
                }
                case 'commits': {
                    if (!args.repo) return 'Error: repo is required (e.g. "owner/repo")';
                    const res = await fetch(`${ghBase}/repos/${args.repo}/commits?per_page=${max}`, { headers });
                    if (!res.ok) return `GitHub API error: ${res.status}`;
                    const commits: any[] = await res.json();
                    if (!Array.isArray(commits)) return `GitHub API error: ${JSON.stringify(commits)}`;
                    const lines = commits.map((c: any) =>
                        `- \`${c.sha?.slice(0, 7)}\` ${c.commit?.message?.split('\n')[0]} — ${c.commit?.author?.name} (${c.commit?.author?.date?.slice(0, 10)})`
                    );
                    return `**Recent Commits** for ${args.repo}:\n\n${lines.join('\n')}`;
                }
                case 'issues': {
                    if (!args.repo) return 'Error: repo is required';
                    const res = await fetch(`${ghBase}/repos/${args.repo}/issues?state=open&per_page=${max}`, { headers });
                    if (!res.ok) return `GitHub API error: ${res.status}`;
                    const issues: any[] = await res.json();
                    if (!Array.isArray(issues)) return `GitHub API error: ${JSON.stringify(issues)}`;
                    const openIssues = issues.filter((i: any) => !i.pull_request);
                    if (!openIssues.length) return `No open issues in ${args.repo}.`;
                    const lines = openIssues.map((i: any) =>
                        `- [#${i.number}] **${i.title}** — ${i.user?.login} (${i.created_at?.slice(0, 10)})`
                    );
                    return `**Open Issues** for ${args.repo}:\n\n${lines.join('\n')}`;
                }
                case 'prs': {
                    if (!args.repo) return 'Error: repo is required';
                    const res = await fetch(`${ghBase}/repos/${args.repo}/pulls?state=open&per_page=${max}`, { headers });
                    if (!res.ok) return `GitHub API error: ${res.status}`;
                    const prs: any[] = await res.json();
                    if (!Array.isArray(prs)) return `GitHub API error: ${JSON.stringify(prs)}`;
                    if (!prs.length) return `No open pull requests in ${args.repo}.`;
                    const lines = prs.map((p: any) =>
                        `- [#${p.number}] **${p.title}** — ${p.user?.login} → ${p.base?.ref} (${p.created_at?.slice(0, 10)})`
                    );
                    return `**Open Pull Requests** for ${args.repo}:\n\n${lines.join('\n')}`;
                }
                default:
                    return `Unknown action: ${args.action}`;
            }
        } catch (err: any) {
            log.error('gc_github failed', { error: err.message });
            return `Error calling GitHub API: ${err.message}`;
        }
    },
});

log.info('GravityClaw integration tools registered: gc_memory_query, gc_memory_save, gc_todoist, gc_jira, gc_gmail_read, gc_github');
