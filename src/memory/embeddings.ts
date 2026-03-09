import { createLogger } from '../utils/logger.js';

const log = createLogger('Embeddings');

const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = 768;

/**
 * Generate a text embedding using the Gemini embedding API.
 * Returns a Float32Array of dimension 768.
 * Uses gemini-embedding-001 with outputDimensionality=768 for compatibility
 * with existing stored embeddings (text-embedding-004 was sunset Jan 2026).
 */
export async function generateEmbedding(
    text: string,
    apiKey: string
): Promise<Float32Array | null> {
    if (!text.trim() || !apiKey) return null;

    // Truncate to ~8000 chars to stay within token limits
    const truncated = text.slice(0, 8000);

    try {
        const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: `models/${EMBEDDING_MODEL}`,
                    content: { parts: [{ text: truncated }] },
                    outputDimensionality: EMBEDDING_DIMENSIONS,
                }),
            }
        );

        if (!resp.ok) {
            const errorText = await resp.text();
            log.warn('Embedding API error', { status: resp.status, error: errorText.slice(0, 200) });
            return null;
        }

        const data = await resp.json() as { embedding?: { values?: number[] } };
        const values = data.embedding?.values;
        if (!values || values.length !== EMBEDDING_DIMENSIONS) {
            log.warn('Unexpected embedding dimensions', { got: values?.length || 0 });
            return null;
        }

        return new Float32Array(values);
    } catch (err: any) {
        log.warn('Embedding generation failed', { error: err.message });
        return null;
    }
}

/**
 * Cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize a Float32Array to a Buffer for SQLite BLOB storage.
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Deserialize a Buffer from SQLite BLOB back to Float32Array.
 */
export function bufferToEmbedding(buf: Buffer): Float32Array {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Float32Array(ab);
}

export { EMBEDDING_DIMENSIONS };
