import Database from 'better-sqlite3';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('KnowledgeBase');

/**
 * Personal Knowledge Base — auto-builds a searchable wiki from conversations, decisions, and learnings.
 * SQLite-backed with semantic search support.
 */
export class KnowledgeBase {
    private db: Database.Database;

    constructor(dataDir: string) {
        this.db = new Database(join(dataDir, 'knowledge_base.db'));
        this.db.pragma('journal_mode = WAL');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS kb_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic TEXT NOT NULL,
                content TEXT NOT NULL,
                sources TEXT DEFAULT '[]',
                tags TEXT DEFAULT '[]',
                entry_type TEXT DEFAULT 'fact',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS kb_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_id INTEGER NOT NULL,
                to_id INTEGER NOT NULL,
                relationship TEXT DEFAULT 'related',
                FOREIGN KEY (from_id) REFERENCES kb_entries(id) ON DELETE CASCADE,
                FOREIGN KEY (to_id) REFERENCES kb_entries(id) ON DELETE CASCADE,
                UNIQUE(from_id, to_id)
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
                topic, content, tags, tokenize='porter'
            );
        `);

        log.info('Knowledge base initialized');
    }

    /**
     * Add a knowledge entry.
     */
    addEntry(topic: string, content: string, opts: { sources?: string[]; tags?: string[]; entryType?: string } = {}): number {
        const result = this.db.prepare(
            'INSERT INTO kb_entries (topic, content, sources, tags, entry_type) VALUES (?, ?, ?, ?, ?)'
        ).run(topic, content, JSON.stringify(opts.sources || []), JSON.stringify(opts.tags || []), opts.entryType || 'fact');

        const id = result.lastInsertRowid as number;

        // Index in FTS
        this.db.prepare('INSERT INTO kb_fts (rowid, topic, content, tags) VALUES (?, ?, ?, ?)').run(
            id, topic, content, (opts.tags || []).join(' ')
        );

        log.info('KB entry added', { id, topic });
        return id;
    }

    /**
     * Search the knowledge base using full-text search.
     */
    search(query: string, limit: number = 10): Array<{ id: number; topic: string; content: string; tags: string[]; entryType: string; rank: number }> {
        const results = this.db.prepare(`
            SELECT kb_entries.id, kb_entries.topic, kb_entries.content, kb_entries.tags, kb_entries.entry_type,
                   rank
            FROM kb_fts
            JOIN kb_entries ON kb_fts.rowid = kb_entries.id
            WHERE kb_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        `).all(query, limit) as any[];

        return results.map(r => ({
            id: r.id,
            topic: r.topic,
            content: r.content,
            tags: JSON.parse(r.tags || '[]'),
            entryType: r.entry_type,
            rank: r.rank,
        }));
    }

    /**
     * List all entries, optionally filtered by type.
     */
    listEntries(opts: { type?: string; limit?: number } = {}): Array<{ id: number; topic: string; content: string; tags: string[]; entryType: string; createdAt: string }> {
        let query = 'SELECT * FROM kb_entries';
        const params: any[] = [];
        if (opts.type) {
            query += ' WHERE entry_type = ?';
            params.push(opts.type);
        }
        query += ' ORDER BY updated_at DESC LIMIT ?';
        params.push(opts.limit || 50);

        return (this.db.prepare(query).all(...params) as any[]).map(r => ({
            id: r.id,
            topic: r.topic,
            content: r.content.slice(0, 200),
            tags: JSON.parse(r.tags || '[]'),
            entryType: r.entry_type,
            createdAt: r.created_at,
        }));
    }

    /**
     * Get a specific entry by ID.
     */
    getEntry(id: number): any | null {
        return this.db.prepare('SELECT * FROM kb_entries WHERE id = ?').get(id) || null;
    }

    /**
     * Update an existing entry.
     */
    updateEntry(id: number, updates: { topic?: string; content?: string; tags?: string[] }): void {
        if (updates.topic) this.db.prepare('UPDATE kb_entries SET topic = ?, updated_at = datetime(\'now\') WHERE id = ?').run(updates.topic, id);
        if (updates.content) this.db.prepare('UPDATE kb_entries SET content = ?, updated_at = datetime(\'now\') WHERE id = ?').run(updates.content, id);
        if (updates.tags) this.db.prepare('UPDATE kb_entries SET tags = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(updates.tags), id);

        // Re-index FTS
        const entry = this.getEntry(id);
        if (entry) {
            this.db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(id);
            this.db.prepare('INSERT INTO kb_fts (rowid, topic, content, tags) VALUES (?, ?, ?, ?)').run(
                id, entry.topic, entry.content, (JSON.parse(entry.tags || '[]')).join(' ')
            );
        }
    }

    /**
     * Delete an entry.
     */
    deleteEntry(id: number): boolean {
        this.db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(id);
        const result = this.db.prepare('DELETE FROM kb_entries WHERE id = ?').run(id);
        return result.changes > 0;
    }

    /**
     * Link two entries.
     */
    linkEntries(fromId: number, toId: number, relationship: string = 'related'): void {
        this.db.prepare('INSERT OR IGNORE INTO kb_links (from_id, to_id, relationship) VALUES (?, ?, ?)').run(fromId, toId, relationship);
    }

    /**
     * Get linked entries.
     */
    getRelated(id: number): Array<{ id: number; topic: string; relationship: string }> {
        return this.db.prepare(`
            SELECT kb_entries.id, kb_entries.topic, kb_links.relationship
            FROM kb_links
            JOIN kb_entries ON kb_links.to_id = kb_entries.id
            WHERE kb_links.from_id = ?
            UNION
            SELECT kb_entries.id, kb_entries.topic, kb_links.relationship
            FROM kb_links
            JOIN kb_entries ON kb_links.from_id = kb_entries.id
            WHERE kb_links.to_id = ?
        `).all(id, id) as any[];
    }

    /**
     * Get stats about the knowledge base.
     */
    getStats(): { total: number; byType: Record<string, number> } {
        const total = (this.db.prepare('SELECT COUNT(*) as c FROM kb_entries').get() as any).c;
        const byType = this.db.prepare('SELECT entry_type, COUNT(*) as c FROM kb_entries GROUP BY entry_type').all() as any[];
        return {
            total,
            byType: Object.fromEntries(byType.map(r => [r.entry_type, r.c])),
        };
    }

    close(): void {
        this.db.close();
    }
}
