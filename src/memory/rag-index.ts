import Database from 'better-sqlite3';
import { join, relative, extname } from 'path';
import { mkdirSync, existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import { generateEmbedding, cosineSimilarity, embeddingToBuffer, bufferToEmbedding, EMBEDDING_DIMENSIONS } from './embeddings.js';

const log = createLogger('RAG');

// File extensions to index
const INDEXABLE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h',
    '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.env', '.sh', '.bash',
    '.css', '.scss', '.html', '.svelte', '.vue',
    '.sql', '.graphql', '.prisma', '.proto',
]);

// Directories to skip
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
    '__pycache__', '.venv', 'venv', '.tox', 'target', '.gradle',
    'generated_images', '.alice',
]);

// Max file size to index (100KB)
const MAX_FILE_SIZE = 100 * 1024;

// Chunk size in characters (~500 tokens)
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;

export interface RAGChunk {
    id: number;
    path: string;
    chunkIndex: number;
    content: string;
    similarity?: number;
}

export class RAGIndex {
    private db: Database.Database;
    private apiKey: string;
    private projectRoot: string;
    private indexing = false;
    private embeddingRunning = false;

    constructor(dataDir: string, apiKey: string, projectRoot: string) {
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }

        this.db = new Database(join(dataDir, 'rag-index.db'));
        this.apiKey = apiKey;
        this.projectRoot = projectRoot;

        // Enable WAL mode for better concurrent read performance
        this.db.pragma('journal_mode = WAL');

        this.createTables();
        log.info('RAG index initialized', { projectRoot });
    }

    private createTables(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS rag_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                embedding BLOB,
                file_mtime REAL NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(path, chunk_index)
            );

            CREATE INDEX IF NOT EXISTS idx_rag_path ON rag_chunks(path);

            CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
                content, path,
                content='rag_chunks',
                content_rowid='id'
            );

            -- Triggers to keep FTS in sync
            CREATE TRIGGER IF NOT EXISTS rag_ai AFTER INSERT ON rag_chunks BEGIN
                INSERT INTO rag_fts(rowid, content, path) VALUES (new.id, new.content, new.path);
            END;

            CREATE TRIGGER IF NOT EXISTS rag_ad AFTER DELETE ON rag_chunks BEGIN
                INSERT INTO rag_fts(rag_fts, rowid, content, path) VALUES ('delete', old.id, old.content, old.path);
            END;

            CREATE TRIGGER IF NOT EXISTS rag_au AFTER UPDATE ON rag_chunks BEGIN
                INSERT INTO rag_fts(rag_fts, rowid, content, path) VALUES ('delete', old.id, old.content, old.path);
                INSERT INTO rag_fts(rowid, content, path) VALUES (new.id, new.content, new.path);
            END;
        `);
    }

    /**
     * Index the project directory. Walks the file tree, chunks files, stores content,
     * and generates embeddings. Only re-indexes files that have changed.
     */
    async indexProject(): Promise<{ indexed: number; skipped: number; total: number }> {
        if (this.indexing) {
            log.warn('Indexing already in progress');
            return { indexed: 0, skipped: 0, total: 0 };
        }

        this.indexing = true;
        let indexed = 0;
        let skipped = 0;
        let total = 0;

        try {
            const files = this.walkDirectory(this.projectRoot);
            total = files.length;
            log.info(`Found ${total} indexable files`);

            for (const filePath of files) {
                const relPath = relative(this.projectRoot, filePath);
                const stat = statSync(filePath);
                const mtime = stat.mtimeMs;

                // Check if file has changed since last index
                const existing = this.db.prepare(
                    'SELECT file_mtime FROM rag_chunks WHERE path = ? LIMIT 1'
                ).get(relPath) as { file_mtime: number } | undefined;

                if (existing && Math.abs(existing.file_mtime - mtime) < 1) {
                    skipped++;
                    continue;
                }

                // File changed or new — chunk and store (NO embedding here — fast local-only)
                try {
                    const content = readFileSync(filePath, 'utf-8');
                    const chunks = this.chunkContent(content, relPath);

                    this.db.prepare('DELETE FROM rag_chunks WHERE path = ?').run(relPath);

                    const insert = this.db.prepare(
                        'INSERT INTO rag_chunks (path, chunk_index, content, file_mtime) VALUES (?, ?, ?, ?)'
                    );

                    const insertMany = this.db.transaction((chunks: Array<{ content: string; index: number }>) => {
                        for (const chunk of chunks) {
                            insert.run(relPath, chunk.index, chunk.content, mtime);
                        }
                    });

                    insertMany(chunks);
                    indexed++;
                } catch (err: any) {
                    log.debug('Failed to index file', { path: relPath, error: err.message });
                }
            }

            // Clean up chunks for deleted files
            const indexedPaths = new Set(files.map(f => relative(this.projectRoot, f)));
            const allPaths = this.db.prepare('SELECT DISTINCT path FROM rag_chunks').all() as Array<{ path: string }>;
            for (const { path } of allPaths) {
                if (!indexedPaths.has(path)) {
                    this.db.prepare('DELETE FROM rag_chunks WHERE path = ?').run(path);
                    log.debug('Removed stale chunks', { path });
                }
            }

            log.info('Indexing complete', { indexed, skipped, total });
        } finally {
            this.indexing = false;
        }

        // Start background embedding queue (non-blocking, sequential)
        this.startBackgroundEmbedding();

        return { indexed, skipped, total };
    }

    /**
     * Background embedding queue — processes UN-embedded chunks one at a time.
     * Runs entirely in the background without blocking startup or requests.
     */
    private startBackgroundEmbedding(): void {
        if (this.embeddingRunning) return;
        this.embeddingRunning = true;

        const processNext = async () => {
            try {
                while (true) {
                    const row = this.db.prepare(
                        'SELECT id, content FROM rag_chunks WHERE embedding IS NULL LIMIT 1'
                    ).get() as { id: number; content: string } | undefined;

                    if (!row) {
                        const stats = this.getStats();
                        log.info('Background embedding complete', stats);
                        break;
                    }

                    const emb = await generateEmbedding(row.content, this.apiKey);
                    if (emb) {
                        this.db.prepare(
                            'UPDATE rag_chunks SET embedding = ? WHERE id = ?'
                        ).run(embeddingToBuffer(emb), row.id);
                    }

                    // 300ms between API calls (~200 RPM, well within limits)
                    await new Promise(r => setTimeout(r, 300));
                }
            } catch (err: any) {
                log.debug('Background embedding error', { error: err.message });
            } finally {
                this.embeddingRunning = false;
            }
        };

        // Start after a short delay to let the gateway finish booting
        setTimeout(() => processNext(), 3000);
    }

    /**
     * Re-index a single file (for live workspace awareness).
     */
    async reindexFile(absolutePath: string): Promise<void> {
        const relPath = relative(this.projectRoot, absolutePath);
        if (!this.shouldIndex(absolutePath)) return;

        try {
            const content = readFileSync(absolutePath, 'utf-8');
            const stat = statSync(absolutePath);
            const chunks = this.chunkContent(content, relPath);

            this.db.prepare('DELETE FROM rag_chunks WHERE path = ?').run(relPath);

            const insert = this.db.prepare(
                'INSERT INTO rag_chunks (path, chunk_index, content, file_mtime) VALUES (?, ?, ?, ?)'
            );
            for (const chunk of chunks) {
                insert.run(relPath, chunk.index, chunk.content, stat.mtimeMs);
            }

            // Trigger background embedding if not already running
            this.startBackgroundEmbedding();
            log.debug('Re-indexed file', { path: relPath, chunks: chunks.length });
        } catch (err: any) {
            log.debug('Re-index failed', { path: relPath, error: err.message });
        }
    }

    /**
     * Remove a file's chunks from the index.
     */
    removeFile(absolutePath: string): void {
        const relPath = relative(this.projectRoot, absolutePath);
        this.db.prepare('DELETE FROM rag_chunks WHERE path = ?').run(relPath);
    }

    /**
     * Semantic search: embed query, compare against stored embeddings.
     */
    async semanticSearch(query: string, limit = 10): Promise<RAGChunk[]> {
        const queryEmb = await generateEmbedding(query, this.apiKey);
        if (!queryEmb) {
            // Fall back to FTS
            return this.textSearch(query, limit);
        }

        const rows = this.db.prepare(
            'SELECT id, path, chunk_index, content, embedding FROM rag_chunks WHERE embedding IS NOT NULL'
        ).all() as Array<{ id: number; path: string; chunk_index: number; content: string; embedding: Buffer }>;

        const scored = rows.map(row => ({
            id: row.id,
            path: row.path,
            chunkIndex: row.chunk_index,
            content: row.content,
            similarity: cosineSimilarity(queryEmb, bufferToEmbedding(row.embedding)),
        }));

        scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
        return scored.slice(0, limit).filter(r => (r.similarity ?? 0) > 0.3);
    }

    /**
     * Full-text search fallback using FTS5.
     */
    textSearch(query: string, limit = 10): RAGChunk[] {
        try {
            const rows = this.db.prepare(`
                SELECT c.id, c.path, c.chunk_index, c.content
                FROM rag_fts f
                JOIN rag_chunks c ON c.id = f.rowid
                WHERE rag_fts MATCH ?
                ORDER BY rank
                LIMIT ?
            `).all(query, limit) as Array<{ id: number; path: string; chunk_index: number; content: string }>;

            return rows.map(r => ({
                id: r.id,
                path: r.path,
                chunkIndex: r.chunk_index,
                content: r.content,
            }));
        } catch {
            return [];
        }
    }

    /**
     * Get index stats.
     */
    getStats(): { totalChunks: number; totalFiles: number; embeddedChunks: number } {
        const total = this.db.prepare('SELECT COUNT(*) as count FROM rag_chunks').get() as { count: number };
        const files = this.db.prepare('SELECT COUNT(DISTINCT path) as count FROM rag_chunks').get() as { count: number };
        const embedded = this.db.prepare('SELECT COUNT(*) as count FROM rag_chunks WHERE embedding IS NOT NULL').get() as { count: number };

        return {
            totalChunks: total.count,
            totalFiles: files.count,
            embeddedChunks: embedded.count,
        };
    }

    // ── Private helpers ──

    private walkDirectory(dir: string): string[] {
        const files: string[] = [];

        try {
            const entries = readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                        files.push(...this.walkDirectory(fullPath));
                    }
                } else if (entry.isFile() && this.shouldIndex(fullPath)) {
                    files.push(fullPath);
                }
            }
        } catch (err: any) {
            log.debug('Directory walk error', { dir, error: err.message });
        }

        return files;
    }

    private shouldIndex(filePath: string): boolean {
        const ext = extname(filePath).toLowerCase();
        if (!INDEXABLE_EXTENSIONS.has(ext)) return false;

        try {
            const stat = statSync(filePath);
            if (stat.size > MAX_FILE_SIZE) return false;
        } catch {
            return false;
        }

        return true;
    }

    private chunkContent(content: string, path: string): Array<{ content: string; index: number }> {
        const chunks: Array<{ content: string; index: number }> = [];

        // Add file path context to each chunk
        const header = `File: ${path}\n\n`;

        if (content.length <= CHUNK_SIZE) {
            chunks.push({ content: header + content, index: 0 });
            return chunks;
        }

        let start = 0;
        let index = 0;

        while (start < content.length) {
            const end = Math.min(start + CHUNK_SIZE, content.length);
            let chunkEnd = end;

            // Try to break at a natural boundary (newline)
            if (end < content.length) {
                const lastNewline = content.lastIndexOf('\n', end);
                if (lastNewline > start + CHUNK_SIZE / 2) {
                    chunkEnd = lastNewline + 1;
                }
            }

            chunks.push({
                content: header + content.slice(start, chunkEnd),
                index,
            });

            start = chunkEnd - CHUNK_OVERLAP;
            if (start >= content.length) break;
            index++;
        }

        return chunks;
    }


    close(): void {
        this.db.close();
    }
}
