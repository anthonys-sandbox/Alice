import Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';
import { generateEmbedding, cosineSimilarity, embeddingToBuffer, bufferToEmbedding } from './embeddings.js';

const log = createLogger('MemConsolidation');

/**
 * Memory consolidation: compresses old session embeddings into topic summaries.
 * Reduces DB size and improves semantic search by clustering related memories.
 *
 * Runs periodically as a background task.
 */
export class MemoryConsolidator {
    private db: Database.Database;
    private apiKey: string;
    private running = false;

    constructor(db: Database.Database, apiKey: string) {
        this.db = db;
        this.apiKey = apiKey;
        this.ensureTable();
    }

    private ensureTable(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory_summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic TEXT NOT NULL,
                summary TEXT NOT NULL,
                source_session_ids TEXT NOT NULL,    -- JSON array of session IDs
                source_message_count INTEGER NOT NULL,
                embedding BLOB,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_summaries_topic ON memory_summaries(topic);
        `);
    }

    /**
     * Consolidate old embeddings: group by session, summarize content,
     * replace individual embeddings with topic-level summaries.
     */
    async consolidate(options?: {
        olderThanDays?: number;   // Only consolidate sessions older than N days (default: 7)
        backgroundModel?: any;    // Background model for summarization
        maxSessions?: number;     // Max sessions per run (default: 10)
    }): Promise<{ consolidated: number; removed: number }> {
        if (this.running) return { consolidated: 0, removed: 0 };
        this.running = true;

        const olderThanDays = options?.olderThanDays ?? 7;
        const maxSessions = options?.maxSessions ?? 10;
        let consolidated = 0;
        let removed = 0;

        try {
            // Find old sessions with many embeddings
            const cutoff = new Date(Date.now() - olderThanDays * 86400_000).toISOString();
            const sessions = this.db.prepare(`
                SELECT s.id, s.title, COUNT(e.message_id) as emb_count
                FROM sessions s
                JOIN message_embeddings e ON e.session_id = s.id
                WHERE s.updated_at < ?
                GROUP BY s.id
                HAVING emb_count > 5
                ORDER BY s.updated_at ASC
                LIMIT ?
            `).all(cutoff, maxSessions) as Array<{ id: string; title: string; emb_count: number }>;

            for (const session of sessions) {
                try {
                    // Check if already consolidated
                    const already = this.db.prepare(
                        "SELECT 1 FROM memory_summaries WHERE source_session_ids LIKE ?"
                    ).get(`%${session.id}%`);
                    if (already) continue;

                    // Load messages for this session
                    const messages = this.db.prepare(`
                        SELECT m.role, m.parts_json
                        FROM messages m
                        WHERE m.session_id = ?
                        ORDER BY m.id ASC
                    `).all(session.id) as Array<{ role: string; parts_json: string }>;

                    // Extract text content
                    const textParts = messages
                        .map(m => {
                            const parts = JSON.parse(m.parts_json);
                            const text = parts
                                .filter((p: any) => p.text)
                                .map((p: any) => p.text)
                                .join(' ');
                            return text ? `[${m.role}]: ${text}` : '';
                        })
                        .filter(t => t.length > 0);

                    if (textParts.length === 0) continue;

                    // Generate a compressed summary
                    const fullContent = textParts.join('\n').slice(0, 4000);
                    const topic = session.title || 'Untitled session';

                    // Use simple extractive summary (first + last messages + key phrases)
                    const summary = this.extractiveSummary(fullContent, topic);

                    // Generate embedding for the summary
                    const emb = await generateEmbedding(summary, this.apiKey);

                    // Store consolidated summary
                    this.db.prepare(`
                        INSERT INTO memory_summaries (topic, summary, source_session_ids, source_message_count, embedding)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(
                        topic,
                        summary,
                        JSON.stringify([session.id]),
                        messages.length,
                        emb ? embeddingToBuffer(emb) : null,
                    );

                    // Remove individual embeddings for this session
                    const result = this.db.prepare(
                        'DELETE FROM message_embeddings WHERE session_id = ?'
                    ).run(session.id);
                    removed += result.changes;

                    consolidated++;
                    log.info('Consolidated session', { id: session.id, title: topic, messages: messages.length });

                    // Rate-limit
                    await new Promise(r => setTimeout(r, 500));
                } catch (err: any) {
                    log.debug('Session consolidation failed', { id: session.id, error: err.message });
                }
            }

            log.info('Consolidation complete', { consolidated, removed });
        } finally {
            this.running = false;
        }

        return { consolidated, removed };
    }

    /**
     * Search consolidated summaries via semantic similarity.
     */
    async searchSummaries(query: string, limit = 5): Promise<Array<{
        topic: string;
        summary: string;
        similarity: number;
    }>> {
        const queryEmb = await generateEmbedding(query, this.apiKey);
        if (!queryEmb) return [];

        const rows = this.db.prepare(
            'SELECT topic, summary, embedding FROM memory_summaries WHERE embedding IS NOT NULL'
        ).all() as Array<{ topic: string; summary: string; embedding: Buffer }>;

        const scored = rows.map(row => ({
            topic: row.topic,
            summary: row.summary,
            similarity: cosineSimilarity(queryEmb, bufferToEmbedding(row.embedding)),
        }));

        return scored
            .filter(r => r.similarity > 0.3)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);
    }

    /**
     * Get consolidation stats.
     */
    getStats(): { summaryCount: number; totalSourceMessages: number } {
        const result = this.db.prepare(
            'SELECT COUNT(*) as count, COALESCE(SUM(source_message_count), 0) as total FROM memory_summaries'
        ).get() as { count: number; total: number };

        return { summaryCount: result.count, totalSourceMessages: result.total };
    }

    /**
     * Simple extractive summary: takes key parts of the conversation
     * to create a compressed representation.
     */
    private extractiveSummary(content: string, topic: string): string {
        const lines = content.split('\n').filter(l => l.trim());
        const userLines = lines.filter(l => l.startsWith('[user]:'));
        const modelLines = lines.filter(l => l.startsWith('[model]:'));

        const parts: string[] = [`Topic: ${topic}`];

        // First user message (original intent)
        if (userLines.length > 0) {
            parts.push(`User asked: ${userLines[0].replace('[user]: ', '').slice(0, 200)}`);
        }

        // Last model response (final answer/outcome)
        if (modelLines.length > 0) {
            parts.push(`Final response: ${modelLines[modelLines.length - 1].replace('[model]: ', '').slice(0, 300)}`);
        }

        // Key topics (unique words that appear often)
        parts.push(`Messages: ${lines.length}, User turns: ${userLines.length}`);

        return parts.join('\n');
    }
}
