import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import { generateEmbedding, cosineSimilarity, embeddingToBuffer, bufferToEmbedding } from './embeddings.js';

const log = createLogger('MemoryStore');

export interface Entity {
    id: number;
    name: string;
    type: string;  // 'person' | 'project' | 'concept' | 'tool' | 'place'
    description: string;
    createdAt: string;
    updatedAt: string;
}

export interface EntityRelation {
    id: number;
    fromId: number;
    toId: number;
    relation: string;  // 'works_on' | 'knows' | 'uses' | 'related_to' | custom
    createdAt: string;
}

export interface MemoryItem {
    id: number;
    file: string;       // 'memory' or 'user'
    section: string;     // e.g. 'Technical Knowledge', 'About Anthony'
    content: string;     // the fact text
    createdAt: string;
    updatedAt: string;
}

export class MemoryStore {
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
        log.info('MemoryStore initialized', { path: dbPath });
    }

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file TEXT NOT NULL,
                section TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_memory_file ON memory_items(file);

            CREATE TABLE IF NOT EXISTS entities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                type TEXT NOT NULL DEFAULT 'concept',
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_entity_type ON entities(type);
            CREATE INDEX IF NOT EXISTS idx_entity_name ON entities(name COLLATE NOCASE);

            CREATE TABLE IF NOT EXISTS entity_relationships (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                to_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                relation TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(from_id, to_id, relation)
            );
            CREATE INDEX IF NOT EXISTS idx_rel_from ON entity_relationships(from_id);
            CREATE INDEX IF NOT EXISTS idx_rel_to ON entity_relationships(to_id);
        `);

        // Add embedding column if not already present
        try {
            this.db.exec('ALTER TABLE memory_items ADD COLUMN embedding BLOB');
            log.info('Added embedding column to memory_items');
        } catch { /* column already exists */ }
    }

    // ── CRUD Operations ───────────────────────────────────────

    /**
     * List all items, optionally filtered by file.
     */
    listItems(file?: string): MemoryItem[] {
        let rows: any[];
        if (file) {
            rows = this.db.prepare(
                'SELECT * FROM memory_items WHERE file = ? ORDER BY section, id'
            ).all(file);
        } else {
            rows = this.db.prepare(
                'SELECT * FROM memory_items ORDER BY file, section, id'
            ).all();
        }
        return rows.map(this.rowToItem);
    }

    /**
     * Get items grouped by section for a specific file.
     */
    getItemsByFile(file: string): { section: string; items: MemoryItem[] }[] {
        const rows = this.db.prepare(
            'SELECT * FROM memory_items WHERE file = ? ORDER BY section, id'
        ).all(file) as any[];

        const sectionMap = new Map<string, MemoryItem[]>();
        for (const row of rows) {
            const item = this.rowToItem(row);
            if (!sectionMap.has(item.section)) {
                sectionMap.set(item.section, []);
            }
            sectionMap.get(item.section)!.push(item);
        }

        return Array.from(sectionMap.entries()).map(([section, items]) => ({
            section,
            items,
        }));
    }

    /**
     * Add a new memory item. Returns the new item's ID.
     */
    addItem(file: string, section: string, content: string): number {
        const cleaned = content.replace(/^[-•*]\s*/, '').trim();
        if (cleaned.length < 3) {
            throw new Error('Content too short');
        }

        // Duplicate check: skip if a very similar item already exists
        const existing = this.findByContent(file, cleaned);
        if (existing) {
            log.debug('Duplicate item skipped', { file, content: cleaned.slice(0, 50) });
            return existing.id;
        }

        const result = this.db.prepare(
            'INSERT INTO memory_items (file, section, content) VALUES (?, ?, ?)'
        ).run(file, section || '', cleaned);

        const id = Number(result.lastInsertRowid);
        log.info('Memory item added', { id, file, section });
        return id;
    }

    /**
     * Delete an item by ID.
     */
    deleteItem(id: number): boolean {
        const result = this.db.prepare(
            'DELETE FROM memory_items WHERE id = ?'
        ).run(id);
        const deleted = result.changes > 0;
        if (deleted) {
            log.info('Memory item deleted', { id });
        }
        return deleted;
    }

    /**
     * Update an item's content by ID.
     */
    updateItem(id: number, content: string): boolean {
        const cleaned = content.replace(/^[-•*]\s*/, '').trim();
        const result = this.db.prepare(
            "UPDATE memory_items SET content = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(cleaned, id);
        const updated = result.changes > 0;
        if (updated) {
            log.info('Memory item updated', { id });
        }
        return updated;
    }

    /**
     * Find an item by fuzzy content match within a file.
     * Used by the agent's update_memory tool for match-based operations.
     */
    findByContent(file: string, text: string): MemoryItem | null {
        const searchText = text.toLowerCase().replace(/^[-•*]\s*/, '').trim();
        // Extract key phrase (first 6 words) for matching
        const words = searchText.split(/\s+/);
        const keyPhrase = words.slice(0, Math.min(6, words.length)).join(' ');

        // Use LIKE for fuzzy matching
        const rows = this.db.prepare(
            'SELECT * FROM memory_items WHERE file = ? AND LOWER(content) LIKE ? LIMIT 1'
        ).all(file, `%${keyPhrase}%`) as any[];

        return rows.length > 0 ? this.rowToItem(rows[0]) : null;
    }

    /**
     * Find items matching a text query (for search_memory tool).
     */
    searchItems(query: string): MemoryItem[] {
        const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        if (queryWords.length === 0) return [];

        // Match items containing at least half the query words
        const rows = this.db.prepare(
            'SELECT * FROM memory_items ORDER BY file, section, id'
        ).all() as any[];

        return rows
            .map(this.rowToItem)
            .filter(item => {
                const contentLower = item.content.toLowerCase();
                const matches = queryWords.filter(w => contentLower.includes(w));
                return matches.length >= Math.max(1, Math.floor(queryWords.length / 2));
            });
    }

    /**
     * Semantic search across memory items using Gemini embeddings.
     * Falls back to keyword search if no embeddings are available.
     */
    async semanticSearchItems(query: string, apiKey: string, limit = 10): Promise<MemoryItem[]> {
        const queryEmbedding = await generateEmbedding(query, apiKey);
        if (!queryEmbedding) {
            return this.searchItems(query);
        }

        const rows = this.db.prepare(
            'SELECT * FROM memory_items WHERE embedding IS NOT NULL'
        ).all() as any[];

        if (rows.length === 0) {
            return this.searchItems(query);
        }

        const scored = rows.map(row => {
            const itemEmb = bufferToEmbedding(row.embedding);
            return { item: this.rowToItem(row), similarity: cosineSimilarity(queryEmbedding, itemEmb) };
        });

        scored.sort((a, b) => b.similarity - a.similarity);
        return scored.slice(0, limit).filter(s => s.similarity > 0.3).map(s => s.item);
    }

    /**
     * Generate and store embedding for a memory item (fire-and-forget).
     */
    async embedItem(id: number, content: string, apiKey: string): Promise<void> {
        try {
            const embedding = await generateEmbedding(content, apiKey);
            if (embedding) {
                this.db.prepare('UPDATE memory_items SET embedding = ? WHERE id = ?').run(embeddingToBuffer(embedding), id);
            }
        } catch (err: any) {
            log.warn('Failed to embed memory item', { id, error: err.message });
        }
    }

    /**
 * Get total item count, optionally by file.
 */
    getCount(file?: string): number {
        if (file) {
            return (this.db.prepare(
                'SELECT COUNT(*) as count FROM memory_items WHERE file = ?'
            ).get(file) as any).count;
        }
        return (this.db.prepare(
            'SELECT COUNT(*) as count FROM memory_items'
        ).get() as any).count;
    }

    // ── Markdown Conversion ───────────────────────────────────

    /**
     * Reconstruct markdown from DB rows for a specific file.
     * Used for system prompt injection and .md file sync.
     */
    toMarkdown(file: string): string {
        const sections = this.getItemsByFile(file);
        const lines: string[] = [];

        // File heading
        if (file === 'user') {
            lines.push('# User Profile', '');
        } else {
            lines.push('# Long-Term Memory', '');
        }

        for (const { section, items } of sections) {
            if (section) {
                lines.push(`## ${section}`, '');
            }
            for (const item of items) {
                lines.push(`- ${item.content}`);
            }
            lines.push('');
        }

        // Handle items with no section
        if (sections.length === 0) {
            lines.push('(No items yet)', '');
        }

        return lines.join('\n');
    }

    /**
     * Sync DB contents to a .md file on disk (for git diffability).
     */
    syncToFile(memoryDir: string, file: string): void {
        const filename = file === 'user' ? 'USER.md' : 'MEMORY.md';
        const filePath = join(memoryDir, filename);
        const markdown = this.toMarkdown(file);
        writeFileSync(filePath, markdown, 'utf-8');
        log.debug(`Synced ${filename} from DB`);
    }

    // ── Migration ─────────────────────────────────────────────

    /**
     * Import items from an existing markdown file into the database.
     * Called once on first startup to migrate from file-based to DB-based storage.
     * Creates a .bak backup of the original file.
     */
    importFromMarkdown(memoryDir: string, file: string): number {
        const filename = file === 'user' ? 'USER.md' : 'MEMORY.md';
        const filePath = join(memoryDir, filename);

        if (!existsSync(filePath)) {
            log.info(`No ${filename} to import`);
            return 0;
        }

        // Skip if we already have items for this file
        if (this.getCount(file) > 0) {
            log.info(`${filename} already imported, skipping`);
            return 0;
        }

        const content = readFileSync(filePath, 'utf-8');

        // Create backup
        const backupPath = filePath + '.bak';
        if (!existsSync(backupPath)) {
            copyFileSync(filePath, backupPath);
            log.info(`Created backup: ${backupPath}`);
        }

        // Parse markdown into sections and items
        const lines = content.split('\n');
        let currentSection = '';
        let imported = 0;

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines and main heading
            if (!trimmed) continue;
            if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) continue;

            // Section heading
            if (trimmed.startsWith('## ')) {
                currentSection = trimmed.replace(/^#+\s*/, '').trim();
                continue;
            }

            // Skip non-content lines (parenthetical descriptions, etc.)
            if (trimmed.startsWith('(') && trimmed.endsWith(')')) continue;

            // Bullet item or checkbox item
            if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')) {
                const itemContent = trimmed
                    .replace(/^[-•*]\s*/, '')          // Remove bullet
                    .replace(/^\[[ x\/]\]\s*/, '')     // Remove checkbox
                    .trim();

                if (itemContent.length >= 5) {
                    try {
                        this.addItem(file, currentSection, itemContent);
                        imported++;
                    } catch (err: any) {
                        log.debug(`Skipped item during import: ${err.message}`);
                    }
                }
                continue;
            }

            // Non-bullet content (freeform text) — still import it
            if (trimmed.length >= 5 && !trimmed.startsWith('---')) {
                try {
                    this.addItem(file, currentSection, trimmed);
                    imported++;
                } catch (err: any) {
                    log.debug(`Skipped line during import: ${err.message}`);
                }
            }
        }

        log.info(`Imported ${imported} items from ${filename}`, { file, sections: this.getItemsByFile(file).length });
        return imported;
    }

    /**
     * Run the full migration for both memory and user files.
     */
    migrateFromFiles(memoryDir: string): void {
        const memoryCount = this.importFromMarkdown(memoryDir, 'memory');
        const userCount = this.importFromMarkdown(memoryDir, 'user');

        if (memoryCount > 0 || userCount > 0) {
            log.info('Memory migration complete', { memory: memoryCount, user: userCount });
        }
    }

    // ── Internal ──────────────────────────────────────────────

    private rowToItem(row: any): MemoryItem {
        return {
            id: row.id,
            file: row.file,
            section: row.section,
            content: row.content,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    close(): void {
        this.db.close();
    }

    // ── Entity Graph ─────────────────────────────────────────────

    /** Add or update an entity. Returns the entity ID. */
    upsertEntity(name: string, type: string, description: string = ''): number {
        const existing = this.db.prepare(
            'SELECT id FROM entities WHERE name = ? COLLATE NOCASE'
        ).get(name) as any;

        if (existing) {
            this.db.prepare(
                "UPDATE entities SET type = ?, description = ?, updated_at = datetime('now') WHERE id = ?"
            ).run(type, description, existing.id);
            return existing.id;
        }

        const result = this.db.prepare(
            'INSERT INTO entities (name, type, description) VALUES (?, ?, ?)'
        ).run(name, type, description);
        log.info('Entity added', { name, type });
        return Number(result.lastInsertRowid);
    }

    /** Add a relationship between two entities. */
    addRelation(fromName: string, toName: string, relation: string): boolean {
        const from = this.db.prepare('SELECT id FROM entities WHERE name = ? COLLATE NOCASE').get(fromName) as any;
        const to = this.db.prepare('SELECT id FROM entities WHERE name = ? COLLATE NOCASE').get(toName) as any;
        if (!from || !to) return false;

        try {
            this.db.prepare(
                'INSERT OR IGNORE INTO entity_relationships (from_id, to_id, relation) VALUES (?, ?, ?)'
            ).run(from.id, to.id, relation);
            log.info('Relation added', { from: fromName, to: toName, relation });
            return true;
        } catch { return false; }
    }

    /** Get an entity by name. */
    getEntity(name: string): Entity | null {
        const row = this.db.prepare(
            'SELECT * FROM entities WHERE name = ? COLLATE NOCASE'
        ).get(name) as any;
        return row ? { id: row.id, name: row.name, type: row.type, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at } : null;
    }

    /** Get all entities, optionally filtered by type. */
    listEntities(type?: string): Entity[] {
        const rows = type
            ? this.db.prepare('SELECT * FROM entities WHERE type = ? ORDER BY name').all(type) as any[]
            : this.db.prepare('SELECT * FROM entities ORDER BY type, name').all() as any[];
        return rows.map(r => ({ id: r.id, name: r.name, type: r.type, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at }));
    }

    /** Get all relationships for an entity (both directions). */
    getRelations(name: string): { entity: string; relation: string; direction: 'from' | 'to' }[] {
        const entity = this.db.prepare('SELECT id FROM entities WHERE name = ? COLLATE NOCASE').get(name) as any;
        if (!entity) return [];

        const outgoing = this.db.prepare(`
            SELECT e.name, r.relation FROM entity_relationships r
            JOIN entities e ON e.id = r.to_id
            WHERE r.from_id = ?
        `).all(entity.id) as any[];

        const incoming = this.db.prepare(`
            SELECT e.name, r.relation FROM entity_relationships r
            JOIN entities e ON e.id = r.from_id
            WHERE r.to_id = ?
        `).all(entity.id) as any[];

        return [
            ...outgoing.map((r: any) => ({ entity: r.name, relation: r.relation, direction: 'from' as const })),
            ...incoming.map((r: any) => ({ entity: r.name, relation: r.relation, direction: 'to' as const })),
        ];
    }

    /** Search entities by name (fuzzy LIKE match). */
    searchEntities(query: string): Entity[] {
        const rows = this.db.prepare(
            'SELECT * FROM entities WHERE name LIKE ? OR description LIKE ? ORDER BY name LIMIT 20'
        ).all(`%${query}%`, `%${query}%`) as any[];
        return rows.map(r => ({ id: r.id, name: r.name, type: r.type, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at }));
    }
}
