import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import type { LLMMessage } from '../runtime/providers/gemini.js';
import { generateEmbedding, cosineSimilarity, embeddingToBuffer, bufferToEmbedding } from './embeddings.js';

const log = createLogger('Sessions');

export interface Session {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
}

export interface Persona {
    id: string;
    name: string;
    description: string;
    soulContent: string;
    identityContent: string;
    isActive: boolean;
    isDefault: boolean;
    createdAt: string;
}

export class SessionStore {
    private db: Database.Database;
    private dataDir: string;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
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

        // Semantic embeddings table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS message_embeddings (
                message_id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                embedding BLOB NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_embeddings_session ON message_embeddings(session_id);
        `);

        // Personas table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS personas (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                soul_content TEXT NOT NULL DEFAULT '',
                identity_content TEXT NOT NULL DEFAULT '',
                is_active INTEGER NOT NULL DEFAULT 0,
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        // Cumulative stats table (survives restarts)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS stats (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);

        // Session summaries for continuity across conversations
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_summaries (
                session_id TEXT PRIMARY KEY,
                summary TEXT NOT NULL,
                topics TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        // Seed default Alice persona if none exist
        const count = this.db.prepare('SELECT COUNT(*) as c FROM personas').get() as { c: number };
        if (count.c === 0) {
            this.seedDefaultPersona();
        }
    }

    /**
     * Seed the default Alice persona from existing SOUL.md and IDENTITY.md.
     */
    private seedDefaultPersona(): void {
        // Try to read from the memory directory (parent of data dir)
        const memoryDir = join(this.dataDir, '..');
        let soul = '';
        let identity = '';

        // Try multiple possible paths
        for (const dir of [memoryDir, this.dataDir, './memory']) {
            const soulPath = join(dir, 'SOUL.md');
            const identityPath = join(dir, 'IDENTITY.md');
            if (!soul && existsSync(soulPath)) {
                soul = readFileSync(soulPath, 'utf-8');
            }
            if (!identity && existsSync(identityPath)) {
                identity = readFileSync(identityPath, 'utf-8');
            }
        }

        this.db.prepare(
            'INSERT INTO personas (id, name, description, soul_content, identity_content, is_active, is_default) VALUES (?, ?, ?, ?, ?, 1, 1)'
        ).run(
            'default',
            'Alice',
            'Your personal AI assistant — warm, capable, and action-oriented.',
            soul,
            identity
        );
        log.info('Seeded default Alice persona');
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
     * Returns the message row ID for embedding generation.
     */
    saveMessage(sessionId: string, message: LLMMessage): number {
        const partsJson = JSON.stringify(message.parts);
        const result = this.db.prepare(
            'INSERT INTO messages (session_id, role, parts_json) VALUES (?, ?, ?)'
        ).run(sessionId, message.role, partsJson);

        const messageId = Number(result.lastInsertRowid);

        // Index text content for FTS5 search
        const textContent = message.parts
            .filter((p: any) => 'text' in p && p.text)
            .map((p: any) => p.text)
            .join(' ');

        if (textContent.trim()) {
            try {
                this.db.prepare(
                    'INSERT INTO messages_fts (content, session_id, role, message_id) VALUES (?, ?, ?, ?)'
                ).run(textContent, sessionId, message.role, messageId);
            } catch {
                // FTS insert failure shouldn't break the main flow
            }
        }

        // Update session timestamp
        this.db.prepare(
            'UPDATE sessions SET updated_at = datetime(\'now\') WHERE id = ?'
        ).run(sessionId);

        return messageId;
    }

    /**
     * Save an embedding for a message (async, non-blocking).
     */
    saveEmbedding(messageId: number, sessionId: string, embedding: Float32Array): void {
        try {
            this.db.prepare(
                'INSERT OR REPLACE INTO message_embeddings (message_id, session_id, embedding) VALUES (?, ?, ?)'
            ).run(messageId, sessionId, embeddingToBuffer(embedding));
        } catch (err: any) {
            log.warn('Failed to save embedding', { messageId, error: err.message });
        }
    }

    /**
     * Generate and store embedding for a message (fire-and-forget).
     */
    async embedMessage(messageId: number, sessionId: string, text: string, apiKey: string): Promise<void> {
        if (!text.trim() || !apiKey) return;
        const embedding = await generateEmbedding(text, apiKey);
        if (embedding) {
            this.saveEmbedding(messageId, sessionId, embedding);
        }
    }

    /**
     * Semantic search across all sessions using cosine similarity.
     * Computes query embedding, then compares against stored embeddings.
     */
    async semanticSearch(query: string, apiKey: string, limit = 10): Promise<Array<{
        content: string;
        sessionId: string;
        role: string;
        sessionTitle: string;
        similarity: number;
    }>> {
        const queryEmbedding = await generateEmbedding(query, apiKey);
        if (!queryEmbedding) return [];

        try {
            // Load all embeddings — for scale we'd use a vector index,
            // but with <100K messages this is fast enough (<50ms)
            const rows = this.db.prepare(`
                SELECT e.message_id, e.session_id, e.embedding,
                       m.role, m.parts_json,
                       COALESCE(s.title, 'Untitled') as session_title
                FROM message_embeddings e
                JOIN messages m ON m.id = e.message_id
                LEFT JOIN sessions s ON s.id = e.session_id
            `).all() as Array<{
                message_id: number;
                session_id: string;
                embedding: Buffer;
                role: string;
                parts_json: string;
                session_title: string;
            }>;

            // Score each embedding
            const scored = rows.map(row => {
                const emb = bufferToEmbedding(row.embedding);
                const similarity = cosineSimilarity(queryEmbedding, emb);
                const text = JSON.parse(row.parts_json)
                    .filter((p: any) => p.text)
                    .map((p: any) => p.text)
                    .join(' ');
                return {
                    content: text.slice(0, 500),
                    sessionId: row.session_id,
                    role: row.role,
                    sessionTitle: row.session_title,
                    similarity,
                };
            });

            // Sort by similarity descending, filter out low scores
            return scored
                .filter(s => s.similarity > 0.3)
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, limit);
        } catch (err: any) {
            log.warn('Semantic search failed', { error: err.message });
            return [];
        }
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

    // ── Session Continuity ────────────────────────────

    /**
     * Save a session summary for cross-session continuity.
     */
    saveSessionSummary(sessionId: string, summary: string, topics: string[]): void {
        this.db.prepare(
            'INSERT OR REPLACE INTO session_summaries (session_id, summary, topics) VALUES (?, ?, ?)'
        ).run(sessionId, summary, JSON.stringify(topics));
        log.info('Session summary saved', { sessionId, topicCount: topics.length });
    }

    /**
     * Get a specific session's summary.
     */
    getSessionSummary(sessionId: string): { summary: string; topics: string[] } | null {
        const row = this.db.prepare(
            'SELECT summary, topics FROM session_summaries WHERE session_id = ?'
        ).get(sessionId) as any;
        if (!row) return null;
        return { summary: row.summary, topics: JSON.parse(row.topics || '[]') };
    }

    /**
     * Get recent session summaries for context continuity.
     * Returns the last N summaries with session titles.
     */
    getRecentSummaries(limit = 5): Array<{ sessionId: string; title: string; summary: string; topics: string[] }> {
        const rows = this.db.prepare(`
            SELECT ss.session_id, COALESCE(s.title, 'Untitled') as title, ss.summary, ss.topics
            FROM session_summaries ss
            LEFT JOIN sessions s ON s.id = ss.session_id
            ORDER BY ss.created_at DESC
            LIMIT ?
        `).all(limit) as any[];

        return rows.map(r => ({
            sessionId: r.session_id,
            title: r.title,
            summary: r.summary,
            topics: JSON.parse(r.topics || '[]'),
        }));
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

    // ── Stats Persistence ────────────────────────────

    /**
     * Save cumulative stats to the database.
     */
    saveStats(stats: { apiCalls: number; toolCalls: number; toolsUsed: Record<string, number> }): void {
        const upsert = this.db.prepare(
            'INSERT OR REPLACE INTO stats (key, value) VALUES (?, ?)'
        );
        const txn = this.db.transaction(() => {
            upsert.run('apiCalls', String(stats.apiCalls));
            upsert.run('toolCalls', String(stats.toolCalls));
            upsert.run('toolsUsed', JSON.stringify(stats.toolsUsed));
        });
        txn();
    }

    /**
     * Load cumulative stats from the database.
     */
    loadStats(): { apiCalls: number; toolCalls: number; toolsUsed: Record<string, number> } {
        const defaults = { apiCalls: 0, toolCalls: 0, toolsUsed: {} as Record<string, number> };
        try {
            const rows = this.db.prepare('SELECT key, value FROM stats').all() as Array<{ key: string; value: string }>;
            for (const row of rows) {
                if (row.key === 'apiCalls') defaults.apiCalls = parseInt(row.value, 10) || 0;
                if (row.key === 'toolCalls') defaults.toolCalls = parseInt(row.value, 10) || 0;
                if (row.key === 'toolsUsed') {
                    try { defaults.toolsUsed = JSON.parse(row.value); } catch { /* keep empty */ }
                }
            }
        } catch (err: any) {
            log.warn('Failed to load stats', { error: err.message });
        }
        return defaults;
    }

    // ── Persona CRUD ────────────────────────────────

    /**
     * Create a new persona.
     */
    createPersona(name: string, description: string, soul: string, identity: string): string {
        const id = this.generateId();
        this.db.prepare(
            'INSERT INTO personas (id, name, description, soul_content, identity_content) VALUES (?, ?, ?, ?, ?)'
        ).run(id, name, description, soul, identity);
        log.info('Persona created', { id, name });
        return id;
    }

    /**
     * List all personas.
     */
    listPersonas(): Persona[] {
        const rows = this.db.prepare(
            'SELECT id, name, description, soul_content, identity_content, is_active, is_default, created_at FROM personas ORDER BY is_default DESC, created_at ASC'
        ).all() as Array<{
            id: string; name: string; description: string;
            soul_content: string; identity_content: string;
            is_active: number; is_default: number; created_at: string;
        }>;
        return rows.map(r => ({
            id: r.id,
            name: r.name,
            description: r.description,
            soulContent: r.soul_content,
            identityContent: r.identity_content,
            isActive: r.is_active === 1,
            isDefault: r.is_default === 1,
            createdAt: r.created_at,
        }));
    }

    /**
     * Get a single persona by ID.
     */
    getPersona(id: string): Persona | null {
        const row = this.db.prepare(
            'SELECT id, name, description, soul_content, identity_content, is_active, is_default, created_at FROM personas WHERE id = ?'
        ).get(id) as any;
        if (!row) return null;
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            soulContent: row.soul_content,
            identityContent: row.identity_content,
            isActive: row.is_active === 1,
            isDefault: row.is_default === 1,
            createdAt: row.created_at,
        };
    }

    /**
     * Update persona fields.
     */
    updatePersona(id: string, updates: Partial<{ name: string; description: string; soulContent: string; identityContent: string }>): void {
        if (updates.name !== undefined) {
            this.db.prepare('UPDATE personas SET name = ? WHERE id = ?').run(updates.name, id);
        }
        if (updates.description !== undefined) {
            this.db.prepare('UPDATE personas SET description = ? WHERE id = ?').run(updates.description, id);
        }
        if (updates.soulContent !== undefined) {
            this.db.prepare('UPDATE personas SET soul_content = ? WHERE id = ?').run(updates.soulContent, id);
        }
        if (updates.identityContent !== undefined) {
            this.db.prepare('UPDATE personas SET identity_content = ? WHERE id = ?').run(updates.identityContent, id);
        }
    }

    /**
     * Delete a persona (cannot delete the default).
     */
    deletePersona(id: string): boolean {
        const persona = this.getPersona(id);
        if (!persona || persona.isDefault) return false;
        this.db.prepare('DELETE FROM personas WHERE id = ?').run(id);
        // If deleted persona was active, reactivate default
        if (persona.isActive) {
            this.db.prepare('UPDATE personas SET is_active = 1 WHERE is_default = 1').run();
        }
        log.info('Persona deleted', { id });
        return true;
    }

    /**
     * Set a persona as the active one (deactivates all others).
     */
    setActivePersona(id: string): void {
        this.db.prepare('UPDATE personas SET is_active = 0').run();
        this.db.prepare('UPDATE personas SET is_active = 1 WHERE id = ?').run(id);
        log.info('Active persona switched', { id });
    }

    /**
     * Get the currently active persona.
     */
    getActivePersona(): Persona | null {
        const row = this.db.prepare(
            'SELECT id, name, description, soul_content, identity_content, is_active, is_default, created_at FROM personas WHERE is_active = 1'
        ).get() as any;
        if (!row) return null;
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            soulContent: row.soul_content,
            identityContent: row.identity_content,
            isActive: true,
            isDefault: row.is_default === 1,
            createdAt: row.created_at,
        };
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
}
