import Database from 'better-sqlite3';
import { join } from 'path';
import { createHmac, randomBytes } from 'crypto';
import { createLogger } from '../utils/logger.js';
import type { AutomationManager } from './automations.js';
import type { Agent } from '../runtime/agent.js';
import type { GoogleChatAdapter } from '../channels/google-chat.js';

const log = createLogger('Webhooks');

// ── Types ───────────────────────────────────────────────────

export interface WebhookConfig {
    id: string;
    name: string;
    /** HMAC secret for payload validation (auto-generated) */
    secret: string;
    /** Optional linked automation rule ID */
    automationId?: string;
    /** Optional JSONPath-like transform: e.g. "action,pull_request.title,sender.login" */
    transform?: string;
    /** Template for the provider to help users set up */
    provider?: string;
    active: boolean;
    createdAt: string;
    lastReceivedAt?: string;
    eventCount: number;
}

export interface WebhookEvent {
    id: number;
    webhookId: string;
    receivedAt: string;
    provider: string;
    eventType: string;
    summary: string;
    status: 'processed' | 'failed' | 'ignored';
    payload?: string;
}

// Provider templates: pre-built header/event detection for popular services
const PROVIDER_TEMPLATES: Record<string, {
    eventHeader: string;
    signatureHeader?: string;
    signaturePrefix?: string;
    hashAlgo?: string;
    describeEvent: (eventType: string, body: any) => string;
}> = {
    github: {
        eventHeader: 'x-github-event',
        signatureHeader: 'x-hub-signature-256',
        signaturePrefix: 'sha256=',
        hashAlgo: 'sha256',
        describeEvent: (type: string, body: any) => {
            switch (type) {
                case 'push':
                    return `Push to ${body.ref?.replace('refs/heads/', '') || '?'} by ${body.pusher?.name || '?'} (${(body.commits || []).length} commits)`;
                case 'pull_request':
                    return `PR #${body.number} ${body.action}: "${body.pull_request?.title}" by ${body.pull_request?.user?.login || '?'}`;
                case 'issues':
                    return `Issue #${body.issue?.number} ${body.action}: "${body.issue?.title}"`;
                case 'workflow_run':
                    return `Workflow "${body.workflow_run?.name}" ${body.workflow_run?.conclusion || body.action}`;
                case 'release':
                    return `Release ${body.action}: ${body.release?.tag_name} — ${body.release?.name || ''}`;
                default:
                    return `GitHub ${type}: ${body.action || 'event received'}`;
            }
        },
    },
    stripe: {
        eventHeader: '',  // Stripe puts type in the body
        signatureHeader: 'stripe-signature',
        describeEvent: (_type: string, body: any) => {
            const evtType = body.type || 'unknown';
            return `Stripe ${evtType}: ${body.data?.object?.id || ''}`;
        },
    },
    linear: {
        eventHeader: '',  // Linear puts type in the body
        describeEvent: (_type: string, body: any) => {
            const action = body.action || 'updated';
            const type = body.type || 'Issue';
            return `Linear ${type} ${action}: ${body.data?.title || body.data?.name || ''}`;
        },
    },
    sentry: {
        eventHeader: 'sentry-hook-resource',
        describeEvent: (type: string, body: any) => {
            return `Sentry ${type}: ${body.data?.error?.title || body.data?.issue?.title || 'alert'}`;
        },
    },
    vercel: {
        eventHeader: '',
        describeEvent: (_type: string, body: any) => {
            const type = body.type || 'deployment';
            return `Vercel ${type}: ${body.payload?.deployment?.name || body.payload?.name || ''}`;
        },
    },
    generic: {
        eventHeader: '',
        describeEvent: (_type: string, _body: any) => 'Webhook event received',
    },
};

// ── Webhook Manager ─────────────────────────────────────────

export class WebhookManager {
    private db: Database.Database;
    private agent: Agent | null = null;
    private chat: GoogleChatAdapter | null = null;
    private automationManager: AutomationManager | null = null;

    constructor(dataDir: string) {
        this.db = new Database(join(dataDir, 'webhooks.db'));
        this.db.pragma('journal_mode = WAL');
        this.ensureTables();
    }

    private ensureTables(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS webhooks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                secret TEXT NOT NULL,
                automation_id TEXT,
                transform TEXT,
                provider TEXT DEFAULT 'generic',
                active INTEGER DEFAULT 1,
                created_at TEXT DEFAULT (datetime('now')),
                last_received_at TEXT,
                event_count INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS webhook_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                webhook_id TEXT NOT NULL,
                received_at TEXT DEFAULT (datetime('now')),
                provider TEXT DEFAULT 'generic',
                event_type TEXT DEFAULT '',
                summary TEXT DEFAULT '',
                status TEXT DEFAULT 'processed',
                payload TEXT,
                FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_events_webhook ON webhook_events(webhook_id);
            CREATE INDEX IF NOT EXISTS idx_events_time ON webhook_events(received_at);
        `);
    }

    /** Wire up references needed for executing actions */
    init(agent: Agent, chat: GoogleChatAdapter, automationManager: AutomationManager | null): void {
        this.agent = agent;
        this.chat = chat;
        this.automationManager = automationManager;
        log.info('Webhook manager initialized');
    }

    // ── CRUD ────────────────────────────────────────────────

    /** Create a new webhook endpoint */
    create(name: string, provider: string = 'generic', automationId?: string, transform?: string): WebhookConfig {
        const id = `wh_${randomBytes(8).toString('hex')}`;
        const secret = randomBytes(32).toString('hex');

        this.db.prepare(
            'INSERT INTO webhooks (id, name, secret, automation_id, transform, provider) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, name, secret, automationId || null, transform || null, provider);

        log.info('Webhook created', { id, name, provider });

        return this.getWebhook(id)!;
    }

    /** Get a single webhook by ID */
    getWebhook(id: string): WebhookConfig | null {
        const row = this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as any;
        if (!row) return null;
        return this.rowToConfig(row);
    }

    /** List all webhooks */
    list(): WebhookConfig[] {
        return (this.db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as any[])
            .map(r => this.rowToConfig(r));
    }

    /** Delete a webhook and its event log */
    delete(id: string): boolean {
        const result = this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
        if (result.changes > 0) {
            this.db.prepare('DELETE FROM webhook_events WHERE webhook_id = ?').run(id);
            log.info('Webhook deleted', { id });
            return true;
        }
        return false;
    }

    /** Toggle a webhook active/inactive */
    toggle(id: string): boolean | null {
        const row = this.db.prepare('SELECT active FROM webhooks WHERE id = ?').get(id) as any;
        if (!row) return null;
        const newState = row.active ? 0 : 1;
        this.db.prepare('UPDATE webhooks SET active = ? WHERE id = ?').run(newState, id);
        return newState === 1;
    }

    /** Update webhook configuration */
    update(id: string, updates: Partial<Pick<WebhookConfig, 'name' | 'provider' | 'automationId' | 'transform'>>): boolean {
        const webhook = this.getWebhook(id);
        if (!webhook) return false;

        if (updates.name !== undefined)
            this.db.prepare('UPDATE webhooks SET name = ? WHERE id = ?').run(updates.name, id);
        if (updates.provider !== undefined)
            this.db.prepare('UPDATE webhooks SET provider = ? WHERE id = ?').run(updates.provider, id);
        if (updates.automationId !== undefined)
            this.db.prepare('UPDATE webhooks SET automation_id = ? WHERE id = ?').run(updates.automationId || null, id);
        if (updates.transform !== undefined)
            this.db.prepare('UPDATE webhooks SET transform = ? WHERE id = ?').run(updates.transform || null, id);

        return true;
    }

    // ── Event Handling ──────────────────────────────────────

    /** Process an incoming webhook payload */
    async handleIncoming(
        webhookId: string,
        headers: Record<string, string>,
        body: any,
        rawBody: Buffer
    ): Promise<{ status: 'processed' | 'failed' | 'ignored'; message: string }> {
        const webhook = this.getWebhook(webhookId);
        if (!webhook) return { status: 'ignored', message: 'Webhook not found' };
        if (!webhook.active) return { status: 'ignored', message: 'Webhook is paused' };

        const provider = webhook.provider || 'generic';
        const template = PROVIDER_TEMPLATES[provider] || PROVIDER_TEMPLATES.generic;

        // Validate HMAC signature if provider supports it
        if (template.signatureHeader && headers[template.signatureHeader]) {
            const expected = headers[template.signatureHeader];
            const algo = template.hashAlgo || 'sha256';
            const computed = createHmac(algo, webhook.secret).update(rawBody).digest('hex');
            const sig = template.signaturePrefix ? `${template.signaturePrefix}${computed}` : computed;

            if (expected !== sig) {
                log.warn('Webhook signature mismatch', { id: webhookId });
                this.logEvent(webhookId, provider, 'invalid_signature', 'Signature validation failed', 'failed');
                return { status: 'failed', message: 'Signature validation failed' };
            }
        }

        // Detect event type
        const eventType = template.eventHeader
            ? (headers[template.eventHeader] || body?.type || 'event')
            : (body?.type || body?.event || body?.action || 'event');

        // Generate human-readable summary
        const summary = template.describeEvent(eventType, body);

        // Log the event
        this.logEvent(webhookId, provider, eventType, summary, 'processed', JSON.stringify(body).slice(0, 5000));

        // Update webhook stats
        this.db.prepare(
            "UPDATE webhooks SET event_count = event_count + 1, last_received_at = datetime('now') WHERE id = ?"
        ).run(webhookId);

        log.info('Webhook received', { id: webhookId, provider, eventType, summary });

        // Execute linked automation or send to Alice
        try {
            if (webhook.automationId && this.automationManager) {
                const rule = this.automationManager.getRule(webhook.automationId);
                if (rule) {
                    // Inject payload fields into the automation prompt
                    const payload = this.extractPayload(body, webhook.transform);
                    const originalValue = rule.action.value;
                    // Replace template variables like {{payload.field}}
                    rule.action.value = originalValue.replace(/\{\{payload\.(\w+(?:\.\w+)*)\}\}/g, (_match, path) => {
                        return this.getNestedValue(payload, path) || '';
                    });
                    await this.automationManager.executeRule(rule);
                    // Restore original value
                    rule.action.value = originalValue;
                    return { status: 'processed', message: `Automation "${rule.name}" triggered` };
                }
            }

            // No linked automation — send a notification via Google Chat
            if (this.chat) {
                await this.chat.sendCard(
                    `🔗 Webhook: ${webhook.name}`,
                    `${provider} · ${eventType}`,
                    summary,
                );
            }

            // Also let Alice process the webhook context if agent is available
            if (this.agent && summary) {
                await this.agent.processBackgroundMessage(
                    `A webhook event was received:\n\nWebhook: ${webhook.name}\nProvider: ${provider}\nEvent: ${eventType}\nSummary: ${summary}\n\nPlease acknowledge this event and note any actions that might be needed. Be brief.`,
                    { useMainProvider: false }
                );
            }

            return { status: 'processed', message: summary };
        } catch (err: any) {
            log.error('Webhook processing failed', { id: webhookId, error: err.message });
            return { status: 'failed', message: err.message };
        }
    }

    // ── Event Log ───────────────────────────────────────────

    /** Log a webhook event */
    private logEvent(webhookId: string, provider: string, eventType: string, summary: string, status: string, payload?: string): void {
        this.db.prepare(
            'INSERT INTO webhook_events (webhook_id, provider, event_type, summary, status, payload) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(webhookId, provider, eventType, summary, status, payload || null);
    }

    /** Get recent events for a webhook */
    getEvents(webhookId: string, limit: number = 20): WebhookEvent[] {
        return this.db.prepare(
            'SELECT * FROM webhook_events WHERE webhook_id = ? ORDER BY received_at DESC LIMIT ?'
        ).all(webhookId, limit) as WebhookEvent[];
    }

    /** Get all recent events across all webhooks */
    getRecentEvents(limit: number = 50): WebhookEvent[] {
        return this.db.prepare(
            'SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?'
        ).all(limit) as WebhookEvent[];
    }

    /** Clean up old events (keep last 500 per webhook) */
    cleanup(): number {
        const result = this.db.prepare(`
            DELETE FROM webhook_events WHERE id NOT IN (
                SELECT id FROM webhook_events ORDER BY received_at DESC LIMIT 500
            )
        `).run();
        return result.changes;
    }

    /** Get available provider templates */
    static getProviders(): string[] {
        return Object.keys(PROVIDER_TEMPLATES);
    }

    // ── Helpers ─────────────────────────────────────────────

    /** Extract specific fields from payload based on transform config */
    private extractPayload(body: any, transform?: string): Record<string, any> {
        if (!transform || !body) return body;

        const fields = transform.split(',').map(f => f.trim());
        const result: Record<string, any> = {};
        for (const field of fields) {
            result[field] = this.getNestedValue(body, field);
        }
        return result;
    }

    /** Access nested object value via dot notation: "pull_request.title" */
    private getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((o, key) => o?.[key], obj);
    }

    private rowToConfig(row: any): WebhookConfig {
        return {
            id: row.id,
            name: row.name,
            secret: row.secret,
            automationId: row.automation_id || undefined,
            transform: row.transform || undefined,
            provider: row.provider || 'generic',
            active: row.active === 1,
            createdAt: row.created_at,
            lastReceivedAt: row.last_received_at || undefined,
            eventCount: row.event_count || 0,
        };
    }

    close(): void {
        this.db.close();
    }
}
