import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseMarkdownFile } from '../utils/markdown.js';
import { createLogger } from '../utils/logger.js';
import type { MemoryStore } from './memory-store.js';

const log = createLogger('Memory');

// Module-level MemoryStore instance (set by Agent on startup)
let memoryStore: MemoryStore | null = null;

export function setMemoryStore(store: MemoryStore): void {
    memoryStore = store;
}

export function getMemoryStore(): MemoryStore | null {
    return memoryStore;
}

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
        user: memoryStore ? loadFromStore('user') : loadFile(memoryDir, 'USER.md'),
        identity: loadFile(memoryDir, 'IDENTITY.md'),
        memory: memoryStore ? loadFromStore('memory') : loadFile(memoryDir, 'MEMORY.md'),
        heartbeat: loadFile(memoryDir, 'HEARTBEAT.md'),
    };

    const loaded = Object.entries(state)
        .filter(([, v]) => v !== null)
        .map(([k]) => k);
    log.info(`Loaded ${loaded.length} memory files`, { files: loaded });

    return state;
}

/**
 * Load memory content from the DB-backed MemoryStore.
 * Reconstructs markdown for injection into the system prompt.
 */
function loadFromStore(file: string): MemoryFile | null {
    if (!memoryStore) return null;
    const markdown = memoryStore.toMarkdown(file);
    return {
        name: file === 'user' ? 'USER.md' : 'MEMORY.md',
        frontmatter: {},
        content: markdown,
    };
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
 * @deprecated Use updateMemory() for structured multi-file updates.
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
 * Structured memory update — routes facts to the correct file and supports corrections.
 */
export interface MemoryUpdate {
    file: 'user' | 'memory';
    action: 'add' | 'update' | 'remove';
    section?: string;   // e.g. "About Anthony", "Preferences", "Active Projects"
    content: string;    // the new fact or replacement content
    match?: string;     // for update/remove: text to find and replace/delete
}

const FILE_MAP: Record<string, string> = {
    user: 'USER.md',
    memory: 'MEMORY.md',
};

const FILE_DEFAULTS: Record<string, string> = {
    user: '# User Context\n\n## About the User\n\n## Preferences\n\n## Active Projects\n\n(Updated by the agent as it learns)\n',
    memory: '# Long-Term Memory\n\nFacts, patterns, and knowledge curated by Alice over time.\n',
};

export async function updateMemory(memoryDir: string, updates: MemoryUpdate[]): Promise<number> {
    // If MemoryStore is available, route through DB
    if (memoryStore) {
        return updateMemoryViaStore(memoryDir, updates);
    }

    // Legacy file-based fallback
    return updateMemoryViaFiles(memoryDir, updates);
}

/**
 * DB-backed memory update — routes add/update/remove through MemoryStore.
 */
async function updateMemoryViaStore(memoryDir: string, updates: MemoryUpdate[]): Promise<number> {
    while (memoryWriteLock) {
        await new Promise(r => setTimeout(r, 50));
    }
    memoryWriteLock = true;

    let totalChanges = 0;

    try {
        for (const update of updates) {
            const file = update.file; // 'user' or 'memory'
            const cleaned = update.content.replace(/^[-•*]\s*/, '').trim();
            if (cleaned.length < 5) continue;

            if (update.action === 'remove' && update.match) {
                const existing = memoryStore!.findByContent(file, update.match);
                if (existing) {
                    memoryStore!.deleteItem(existing.id);
                    totalChanges++;
                    log.info(`Removed from ${file} via DB`, { match: update.match, id: existing.id });
                }
            } else if (update.action === 'update' && update.match) {
                const existing = memoryStore!.findByContent(file, update.match);
                if (existing) {
                    memoryStore!.updateItem(existing.id, cleaned);
                    totalChanges++;
                    log.info(`Updated in ${file} via DB`, { id: existing.id, old: update.match, new: cleaned });
                } else {
                    // Match not found — treat as add
                    memoryStore!.addItem(file, update.section || '', cleaned);
                    totalChanges++;
                    log.info(`Added to ${file} via DB (update target not found)`, { content: cleaned });
                }
            } else if (update.action === 'add') {
                try {
                    memoryStore!.addItem(file, update.section || '', cleaned);
                    totalChanges++;
                } catch {
                    // Duplicate — skip silently
                }
            }
        }

        // Sync DB to .md files for git diffability
        if (totalChanges > 0) {
            memoryStore!.syncToFile(memoryDir, 'memory');
            memoryStore!.syncToFile(memoryDir, 'user');
        }
    } finally {
        memoryWriteLock = false;
    }

    if (totalChanges > 0) {
        log.info(`Memory updated via DB`, { changes: totalChanges });
    }
    return totalChanges;
}

/**
 * Legacy file-based memory update (used when MemoryStore is not available).
 */
async function updateMemoryViaFiles(memoryDir: string, updates: MemoryUpdate[]): Promise<number> {
    while (memoryWriteLock) {
        await new Promise(r => setTimeout(r, 50));
    }
    memoryWriteLock = true;

    let totalChanges = 0;

    try {
        // Group updates by target file
        const grouped = new Map<string, MemoryUpdate[]>();
        for (const u of updates) {
            const filename = FILE_MAP[u.file] || 'MEMORY.md';
            if (!grouped.has(filename)) grouped.set(filename, []);
            grouped.get(filename)!.push(u);
        }

        for (const [filename, fileUpdates] of grouped) {
            const filePath = join(memoryDir, filename);
            let content = '';
            if (existsSync(filePath)) {
                content = readFileSync(filePath, 'utf-8');
            } else {
                content = FILE_DEFAULTS[filename === 'USER.md' ? 'user' : 'memory'];
            }

            const MAX_SIZE = 8192;
            if (content.length > MAX_SIZE) {
                log.warn(`${filename} approaching size limit, skipping updates`, { size: content.length });
                continue;
            }

            for (const update of fileUpdates) {
                const cleaned = update.content.replace(/^[-•*]\s*/, '').trim();
                if (cleaned.length < 5) continue;

                if (update.action === 'remove' && update.match) {
                    const lines = content.split('\n');
                    const matchLower = update.match.toLowerCase();
                    const before = lines.length;
                    const filtered = lines.filter(line => {
                        const lineLower = line.replace(/^[-•*]\s*/, '').trim().toLowerCase();
                        return !lineLower.includes(matchLower);
                    });
                    if (filtered.length < before) {
                        content = filtered.join('\n');
                        totalChanges++;
                        log.info(`Removed from ${filename}`, { match: update.match });
                    }
                } else if (update.action === 'update' && update.match) {
                    const lines = content.split('\n');
                    const matchLower = update.match.toLowerCase();
                    let replaced = false;
                    for (let i = 0; i < lines.length; i++) {
                        const lineLower = lines[i].replace(/^[-•*]\s*/, '').trim().toLowerCase();
                        if (lineLower.includes(matchLower)) {
                            lines[i] = `- ${cleaned}`;
                            replaced = true;
                            totalChanges++;
                            log.info(`Updated in ${filename}`, { old: update.match, new: cleaned });
                            break;
                        }
                    }
                    if (!replaced) {
                        content = addToSection(content, update.section, cleaned);
                        totalChanges++;
                        log.info(`Added to ${filename} (update target not found)`, { content: cleaned });
                    } else {
                        content = lines.join('\n');
                    }
                } else if (update.action === 'add') {
                    const contentLower = content.toLowerCase();
                    const words = cleaned.toLowerCase().split(/\s+/);
                    const keyPhrase = words.slice(0, Math.min(6, words.length)).join(' ');
                    if (contentLower.includes(keyPhrase)) continue;

                    content = addToSection(content, update.section, cleaned);
                    totalChanges++;
                    log.info(`Added to ${filename}`, { section: update.section, content: cleaned });
                }
            }

            writeFileSync(filePath, content, 'utf-8');
        }
    } finally {
        memoryWriteLock = false;
    }

    if (totalChanges > 0) {
        log.info(`Memory updated`, { changes: totalChanges });
    }
    return totalChanges;
}

/**
 * Add a bullet point under a specific section heading, or at the end if no section matches.
 */
function addToSection(content: string, section: string | undefined, fact: string): string {
    if (!section) {
        // No section specified — append at end
        return content.trimEnd() + `\n- ${fact}\n`;
    }

    const lines = content.split('\n');
    const sectionLower = section.toLowerCase();

    // Find the section heading
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(sectionLower) && lines[i].trim().startsWith('#')) {
            // Find the end of this section (next heading or end of file)
            let insertAt = i + 1;
            while (insertAt < lines.length && !lines[insertAt].trim().startsWith('#')) {
                insertAt++;
            }
            // Insert before the next section heading (or at end)
            // Back up past empty lines to keep formatting clean
            while (insertAt > i + 1 && lines[insertAt - 1].trim() === '') {
                insertAt--;
            }
            lines.splice(insertAt, 0, `- ${fact}`);
            return lines.join('\n');
        }
    }

    // Section not found — append at end
    return content.trimEnd() + `\n- ${fact}\n`;
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

/**
 * Consolidate and refine memory files using the LLM.
 * Removes duplicates, prunes stale info, and organizes facts into clean sections.
 */
export interface ConsolidationProvider {
    generateContent(
        systemInstruction: string,
        messages: { role: string; parts: { text: string }[] }[],
        functionDeclarations: any[]
    ): Promise<{ text: string | null }>;
}

export async function consolidateMemory(
    memoryDir: string,
    provider: ConsolidationProvider
): Promise<{ memoryChanged: boolean; userChanged: boolean }> {
    while (memoryWriteLock) {
        await new Promise(r => setTimeout(r, 50));
    }
    memoryWriteLock = true;
    const result = { memoryChanged: false, userChanged: false };

    try {
        const memoryPath = join(memoryDir, 'MEMORY.md');
        if (existsSync(memoryPath)) {
            const raw = readFileSync(memoryPath, 'utf-8');
            if (raw.length > 500) {
                const out = await consolidateFile(provider, 'MEMORY.md', raw,
                    'Rewrite as a clean knowledge base. Remove "Learned YYYY-MM-DD" headers, organize by topic. ' +
                    'Remove tool-meta, stale disk stats, failed commands, duplicates. ' +
                    'Sections: "## Technical Knowledge", "## Projects", "## Workflows". One bullet per fact.');
                if (out && out !== raw) {
                    writeFileSync(memoryPath, out, 'utf-8');
                    result.memoryChanged = true;
                    log.info('MEMORY.md consolidated', { before: raw.length, after: out.length });
                }
            }
        }

        const userPath = join(memoryDir, 'USER.md');
        if (existsSync(userPath)) {
            const raw = readFileSync(userPath, 'utf-8');
            if (raw.length > 200) {
                const out = await consolidateFile(provider, 'USER.md', raw,
                    'Rewrite as a clean user profile. Sections: "## About Anthony", "## Preferences", "## Active Projects". ' +
                    'Merge duplicates, remove placeholders. One bullet per fact.');
                if (out && out !== raw) {
                    writeFileSync(userPath, out, 'utf-8');
                    result.userChanged = true;
                    log.info('USER.md consolidated', { before: raw.length, after: out.length });
                }
            }
        }
    } catch (err: any) {
        log.error('Memory consolidation failed', { error: err.message });
    } finally {
        memoryWriteLock = false;
    }

    if (result.memoryChanged || result.userChanged) {
        log.info('Memory consolidation complete', result);
    }
    return result;
}

async function consolidateFile(
    provider: ConsolidationProvider,
    filename: string,
    content: string,
    instructions: string
): Promise<string | null> {
    try {
        const prompt = `Current ${filename}:\n\n---\n${content}\n---\n\n${instructions}\n\nOutput ONLY the rewritten file. No code fences. Start with # heading.`;
        const res = await provider.generateContent(
            'You are a memory consolidation system. Output only the cleaned file content. /no_think',
            [{ role: 'user', parts: [{ text: prompt }] }],
            []
        );
        const text = (res.text || '').trim();
        if (text.length < 50 || !text.startsWith('#')) {
            log.warn(`Consolidation for ${filename} invalid`, { length: text.length });
            return null;
        }
        return text + '\n';
    } catch (err: any) {
        log.error(`Consolidation failed for ${filename}`, { error: err.message });
        return null;
    }
}

