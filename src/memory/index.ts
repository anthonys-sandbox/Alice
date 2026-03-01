import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseMarkdownFile } from '../utils/markdown.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Memory');

export interface MemoryFile {
    name: string;
    frontmatter: Record<string, any>;
    content: string;
}

export interface MemoryState {
    soul: MemoryFile | null;
    user: MemoryFile | null;
    identity: MemoryFile | null;
    memory: MemoryFile | null;
    heartbeat: MemoryFile | null;
}

/**
 * Load all memory files from the memory directory.
 */
export function loadMemory(memoryDir: string): MemoryState {
    log.info('Loading memory files', { dir: memoryDir });

    const state: MemoryState = {
        soul: loadFile(memoryDir, 'SOUL.md'),
        user: loadFile(memoryDir, 'USER.md'),
        identity: loadFile(memoryDir, 'IDENTITY.md'),
        memory: loadFile(memoryDir, 'MEMORY.md'),
        heartbeat: loadFile(memoryDir, 'HEARTBEAT.md'),
    };

    const loaded = Object.entries(state)
        .filter(([, v]) => v !== null)
        .map(([k]) => k);
    log.info(`Loaded ${loaded.length} memory files`, { files: loaded });

    return state;
}

function loadFile(dir: string, filename: string): MemoryFile | null {
    const filePath = join(dir, filename);
    const parsed = parseMarkdownFile(filePath);
    if (!parsed) {
        log.debug(`Memory file not found: ${filename}`);
        return null;
    }
    return {
        name: filename,
        frontmatter: parsed.frontmatter,
        content: parsed.content,
    };
}

/**
 * Build the system prompt from memory files.
 * This is injected into the LLM context at the start of each conversation.
 */
export function buildSystemPrompt(memory: MemoryState): string {
    const sections: string[] = [];

    if (memory.identity?.content) {
        sections.push(`<identity>\n${memory.identity.content}\n</identity>`);
    }

    if (memory.soul?.content) {
        sections.push(`<soul>\n${memory.soul.content}\n</soul>`);
    }

    if (memory.user?.content) {
        sections.push(`<user_context>\n${memory.user.content}\n</user_context>`);
    }

    if (memory.memory?.content) {
        sections.push(`<long_term_memory>\n${memory.memory.content}\n</long_term_memory>`);
    }

    return sections.join('\n\n');
}

/**
 * Append an entry to the daily log.
 */
export function appendDailyLog(memoryDir: string, entry: string): void {
    const dailyDir = join(memoryDir, 'daily');
    if (!existsSync(dailyDir)) mkdirSync(dailyDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const logPath = join(dailyDir, `${today}.md`);

    const timestamp = new Date().toISOString().slice(11, 19);
    const line = `- **${timestamp}** ${entry}\n`;

    if (existsSync(logPath)) {
        const current = readFileSync(logPath, 'utf-8');
        writeFileSync(logPath, current + line);
    } else {
        const header = `# Daily Log — ${today}\n\n`;
        writeFileSync(logPath, header + line);
    }
}

/**
 * Update a specific memory file (e.g., USER.md, MEMORY.md).
 */
export function updateMemoryFile(memoryDir: string, filename: string, content: string): void {
    const filePath = join(memoryDir, filename);
    writeFileSync(filePath, content, 'utf-8');
    log.info(`Updated memory file: ${filename}`);
}

/**
 * Append new facts to MEMORY.md, deduplicating against existing content.
 * Returns the number of facts actually appended.
 */
let memoryWriteLock = false;
export async function appendFacts(memoryDir: string, facts: string[]): Promise<number> {
    // Simple mutex to prevent concurrent writes
    while (memoryWriteLock) {
        await new Promise(r => setTimeout(r, 50));
    }
    memoryWriteLock = true;

    try {
        const filePath = join(memoryDir, 'MEMORY.md');
        let existing = '';
        if (existsSync(filePath)) {
            existing = readFileSync(filePath, 'utf-8');
        } else {
            existing = '# Long-Term Memory\n\nFacts, patterns, and knowledge curated by Alice over time.\n';
        }

        const existingLower = existing.toLowerCase();

        // Filter out facts that are already present (fuzzy: check if the core content is already there)
        const newFacts = facts.filter(fact => {
            const cleaned = fact.replace(/^[-•*]\s*/, '').trim();
            if (cleaned.length < 10) return false; // Too short to be meaningful
            // Check if a significant portion of the fact already exists
            const words = cleaned.toLowerCase().split(/\s+/);
            const keyPhrase = words.slice(0, Math.min(6, words.length)).join(' ');
            return !existingLower.includes(keyPhrase);
        });

        if (newFacts.length === 0) return 0;

        // Cap total memory file at ~8KB to prevent system prompt bloat
        const MAX_MEMORY_SIZE = 8192;
        if (existing.length > MAX_MEMORY_SIZE) {
            log.warn('MEMORY.md approaching size limit, skipping append', { size: existing.length });
            return 0;
        }

        const timestamp = new Date().toISOString().slice(0, 10);
        const factsBlock = newFacts.map(f => {
            const cleaned = f.replace(/^[-•*]\s*/, '').trim();
            return `- ${cleaned}`;
        }).join('\n');

        const appendSection = `\n\n## Learned ${timestamp}\n${factsBlock}\n`;
        writeFileSync(filePath, existing.trimEnd() + appendSection, 'utf-8');
        log.info(`Appended ${newFacts.length} new facts to MEMORY.md`);
        return newFacts.length;
    } finally {
        memoryWriteLock = false;
    }
}

/**
 * Search across all memory files for matching content (case-insensitive).
 * Returns matching lines with their source file.
 */
export function searchMemoryFiles(memoryDir: string, query: string): string[] {
    const results: string[] = [];
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    const files = ['MEMORY.md', 'USER.md', 'IDENTITY.md', 'SOUL.md'];
    for (const filename of files) {
        const filePath = join(memoryDir, filename);
        if (!existsSync(filePath)) continue;

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
            if (!line.trim() || line.startsWith('#')) continue;
            const lineLower = line.toLowerCase();
            // Match if any query word appears in the line
            const matches = queryWords.filter(w => lineLower.includes(w));
            if (matches.length >= Math.max(1, Math.floor(queryWords.length / 2))) {
                results.push(`[${filename}] ${line.trim()}`);
            }
        }
    }

    return results;
}

