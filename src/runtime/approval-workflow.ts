import Database from 'better-sqlite3';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ApprovalWorkflow');

interface PendingApproval {
    id: string;
    tool: string;
    args: Record<string, any>;
    preview: string;
    createdAt: string;
    status: 'pending' | 'approved' | 'rejected' | 'expired';
}

/**
 * Approval Workflow — intercepts high-stakes tool calls and requires user approval.
 * Configurable: which tools require approval.
 */
export class ApprovalWorkflow {
    private db: Database.Database;
    private toolsRequiringApproval: Set<string>;

    constructor(dataDir: string) {
        this.db = new Database(join(dataDir, 'approvals.db'));
        this.db.pragma('journal_mode = WAL');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS approvals (
                id TEXT PRIMARY KEY,
                tool TEXT NOT NULL,
                args TEXT NOT NULL,
                preview TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                reviewer_note TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                resolved_at TEXT
            );

            CREATE TABLE IF NOT EXISTS approval_config (
                tool TEXT PRIMARY KEY,
                enabled INTEGER DEFAULT 1
            );
        `);

        // Default tools that require approval
        this.toolsRequiringApproval = new Set([
            'gmail_send',
            'calendar_create',
            'github_create_issue',
            'docs_create',
            'sheets_write',
        ]);

        // Load custom config
        const customTools = this.db.prepare('SELECT tool FROM approval_config WHERE enabled = 1').all() as any[];
        customTools.forEach(t => this.toolsRequiringApproval.add(t.tool));

        log.info('Approval workflow initialized', { tools: [...this.toolsRequiringApproval] });
    }

    /**
     * Check if a tool requires approval.
     */
    requiresApproval(toolName: string): boolean {
        return this.toolsRequiringApproval.has(toolName);
    }

    /**
     * Request approval for a tool call.
     */
    requestApproval(tool: string, args: Record<string, any>, preview: string): string {
        const id = `apr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.db.prepare(
            'INSERT INTO approvals (id, tool, args, preview) VALUES (?, ?, ?, ?)'
        ).run(id, tool, JSON.stringify(args), preview);
        log.info('Approval requested', { id, tool });
        return id;
    }

    /**
     * Approve a pending request.
     */
    approve(id: string, note?: string): PendingApproval | null {
        const row = this.db.prepare('SELECT * FROM approvals WHERE id = ? AND status = ?').get(id, 'pending') as any;
        if (!row) return null;

        this.db.prepare(
            "UPDATE approvals SET status = 'approved', reviewer_note = ?, resolved_at = datetime('now') WHERE id = ?"
        ).run(note || null, id);

        return {
            id: row.id,
            tool: row.tool,
            args: JSON.parse(row.args),
            preview: row.preview,
            createdAt: row.created_at,
            status: 'approved',
        };
    }

    /**
     * Reject a pending request.
     */
    reject(id: string, note?: string): boolean {
        const result = this.db.prepare(
            "UPDATE approvals SET status = 'rejected', reviewer_note = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'pending'"
        ).run(note || null, id);
        return result.changes > 0;
    }

    /**
     * Get all pending approvals.
     */
    getPending(): PendingApproval[] {
        return (this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC").all() as any[]).map(r => ({
            id: r.id,
            tool: r.tool,
            args: JSON.parse(r.args),
            preview: r.preview,
            createdAt: r.created_at,
            status: r.status,
        }));
    }

    /**
     * Get recent approval log.
     */
    getLog(limit: number = 20): any[] {
        return this.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
    }

    /**
     * Add or remove a tool from the approval list.
     */
    configureApproval(tool: string, requireApproval: boolean): void {
        if (requireApproval) {
            this.toolsRequiringApproval.add(tool);
            this.db.prepare('INSERT OR REPLACE INTO approval_config (tool, enabled) VALUES (?, 1)').run(tool);
        } else {
            this.toolsRequiringApproval.delete(tool);
            this.db.prepare('DELETE FROM approval_config WHERE tool = ?').run(tool);
        }
    }

    /**
     * Get the list of tools requiring approval.
     */
    getConfiguredTools(): string[] {
        return [...this.toolsRequiringApproval];
    }

    /**
     * Expire old pending approvals (>24 hours).
     */
    expireOld(): number {
        const result = this.db.prepare(
            "UPDATE approvals SET status = 'expired', resolved_at = datetime('now') WHERE status = 'pending' AND created_at < datetime('now', '-24 hours')"
        ).run();
        return result.changes;
    }

    close(): void {
        this.db.close();
    }
}
