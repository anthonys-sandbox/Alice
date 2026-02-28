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
