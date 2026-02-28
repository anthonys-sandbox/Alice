import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import type { LLMMessage } from '../runtime/providers/gemini.js';

const log = createLogger('Sessions');

export interface Session {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
}

export class SessionStore {
    private db: Database.Database;

    constructor(dataDir: string) {
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }

        const dbPath = join(dataDir, 'sessions.db');
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.migrate();
        log.info('SessionStore initialized', { path: dbPath });
    }

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'Untitled',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                parts_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        `);

        // FTS5 full-text search for RAG
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                    content,
                    session_id UNINDEXED,
                    role UNINDEXED,
                    message_id UNINDEXED
                );
            `);
        } catch (err: any) {
            log.warn('FTS5 init skipped (may already exist)', { error: err.message });
        }
    }

    /**
     * Create a new session and return its ID.
     */
    createSession(title?: string): string {
        const id = this.generateId();
        const stmt = this.db.prepare(
            'INSERT INTO sessions (id, title) VALUES (?, ?)'
        );
        stmt.run(id, title || 'Untitled');
        log.info('Session created', { id, title });
        return id;
    }

    /**
     * Save a message to a session and index for full-text search.
     */
    saveMessage(sessionId: string, message: LLMMessage): void {
        const partsJson = JSON.stringify(message.parts);
        const result = this.db.prepare(
            'INSERT INTO messages (session_id, role, parts_json) VALUES (?, ?, ?)'
        ).run(sessionId, message.role, partsJson);

        // Index text content for FTS5 search
        const textContent = message.parts
            .filter((p: any) => 'text' in p && p.text)
            .map((p: any) => p.text)
            .join(' ');

        if (textContent.trim()) {
            try {
                this.db.prepare(
                    'INSERT INTO messages_fts (content, session_id, role, message_id) VALUES (?, ?, ?, ?)'
                ).run(textContent, sessionId, message.role, result.lastInsertRowid);
            } catch {
                // FTS insert failure shouldn't break the main flow
            }
        }

        // Update session timestamp
        this.db.prepare(
            'UPDATE sessions SET updated_at = datetime(\'now\') WHERE id = ?'
        ).run(sessionId);
    }

    /**
     * Load all messages for a session, ordered by creation time.
     */
    loadMessages(sessionId: string): LLMMessage[] {
        const rows = this.db.prepare(
            'SELECT role, parts_json FROM messages WHERE session_id = ? ORDER BY id ASC'
        ).all(sessionId) as Array<{ role: string; parts_json: string }>;

        return rows.map(row => ({
            role: row.role as LLMMessage['role'],
            parts: JSON.parse(row.parts_json),
        }));
    }

    /**
     * List sessions, most recent first.
     */
    listSessions(limit = 50): Session[] {
        const rows = this.db.prepare(`
            SELECT s.id, s.title, s.created_at, s.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count
            FROM sessions s
            GROUP BY s.id
            HAVING message_count > 0
            ORDER BY s.updated_at DESC
            LIMIT ?
        `).all(limit) as Array<{
            id: string;
            title: string;
            created_at: string;
            updated_at: string;
            message_count: number;
        }>;

        return rows.map(row => ({
            id: row.id,
            title: row.title,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            messageCount: row.message_count,
        }));
    }

    /**
     * Get the most recently updated session, or null if none exist.
     */
    getLatestSession(): Session | null {
        const sessions = this.listSessions(1);
        return sessions.length > 0 ? sessions[0] : null;
    }

    /**
     * Update session title (e.g., from first message).
     */
    updateTitle(sessionId: string, title: string): void {
        this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionId);
    }

    /**
     * Delete a session and all its messages.
     */
    deleteSession(sessionId: string): void {
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        log.info('Session deleted', { id: sessionId });
    }

    /**
     * Close the database connection.
     */
    close(): void {
        this.db.close();
    }

    /**
     * Search messages across all sessions using FTS5.
     * Returns matching text snippets with session metadata.
     */
    searchMessages(query: string, limit = 10): Array<{
        content: string;
        sessionId: string;
        role: string;
        sessionTitle: string;
    }> {
        try {
            const rows = this.db.prepare(`
                SELECT f.content, f.session_id, f.role,
                       COALESCE(s.title, 'Untitled') as session_title
                FROM messages_fts f
                LEFT JOIN sessions s ON s.id = f.session_id
                WHERE messages_fts MATCH ?
                ORDER BY rank
                LIMIT ?
            `).all(query, limit) as Array<{
                content: string;
                session_id: string;
                role: string;
                session_title: string;
            }>;

            return rows.map(row => ({
                content: row.content.slice(0, 500),
                sessionId: row.session_id,
                role: row.role,
                sessionTitle: row.session_title,
            }));
        } catch (err: any) {
            log.warn('FTS search failed', { error: err.message });
            return [];
        }
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
}
