import { watch, FSWatcher, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { createLogger } from '../utils/logger.js';
import type { RAGIndex } from '../memory/rag-index.js';

const log = createLogger('FileWatcher');

// Same extensions as rag-index for consistency
const WATCHABLE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h',
    '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.env', '.sh', '.bash',
    '.css', '.scss', '.html', '.svelte', '.vue',
    '.sql', '.graphql', '.prisma', '.proto',
]);

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
    '__pycache__', '.venv', 'venv', '.tox', 'target', '.gradle',
    'generated_images', '.alice', 'menubar',
]);

/**
 * Watches the project directory for file changes and triggers incremental
 * RAG re-indexing. Uses per-directory watchers to avoid OOM from watching
 * node_modules and other heavy directories.
 */
export class FileWatcher {
    private watchers: FSWatcher[] = [];
    private ragIndex: RAGIndex;
    private projectRoot: string;
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private running = false;

    constructor(ragIndex: RAGIndex, projectRoot: string) {
        this.ragIndex = ragIndex;
        this.projectRoot = projectRoot;
    }

    /**
     * Start watching relevant source directories (NOT node_modules, .git, etc.).
     * Uses per-directory watchers instead of recursive root watch to avoid OOM.
     */
    start(): void {
        if (this.running) return;
        this.running = true;

        try {
            const dirs = this.collectWatchableDirs(this.projectRoot, 0);
            for (const dir of dirs) {
                try {
                    const watcher = watch(dir, (event, filename) => {
                        if (!filename) return;
                        // Build relative path from project root
                        const relDir = dir.slice(this.projectRoot.length + 1);
                        const relPath = relDir ? `${relDir}/${filename}` : filename;
                        this.handleChange(event, relPath);
                    });
                    this.watchers.push(watcher);
                } catch {
                    // Skip dirs we can't watch
                }
            }
            log.info('File watcher started', { directories: dirs.length });
        } catch (err: any) {
            log.warn('File watcher failed to start', { error: err.message });
        }
    }

    /**
     * Stop all watchers.
     */
    stop(): void {
        for (const w of this.watchers) {
            w.close();
        }
        this.watchers = [];
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.running = false;
        log.info('File watcher stopped');
    }

    /**
     * Collect directories to watch (skipping node_modules, .git, etc.).
     * Max depth 5 to avoid runaway recursion.
     */
    private collectWatchableDirs(dir: string, depth: number): string[] {
        const dirs: string[] = [dir];  // Watch this dir itself
        if (depth >= 5) return dirs;

        try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (SKIP_DIRS.has(entry.name)) continue;
                if (entry.name.startsWith('.')) continue;
                dirs.push(...this.collectWatchableDirs(join(dir, entry.name), depth + 1));
            }
        } catch {
            // Skip unreadable dirs
        }

        return dirs;
    }

    private handleChange(event: string, filename: string): void {
        const ext = extname(filename).toLowerCase();
        if (!WATCHABLE_EXTENSIONS.has(ext)) return;

        // Check if file is in a skip directory
        const parts = filename.split('/');
        if (parts.some(p => SKIP_DIRS.has(p) || p.startsWith('.'))) return;

        // Debounce — wait 500ms after last change before re-indexing
        const existing = this.debounceTimers.get(filename);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(filename, setTimeout(async () => {
            this.debounceTimers.delete(filename);
            const absolutePath = join(this.projectRoot, filename);

            try {
                if (event === 'rename') {
                    // File could be created or deleted — try to stat
                    try {
                        statSync(absolutePath);
                        await this.ragIndex.reindexFile(absolutePath);
                        log.debug('Re-indexed', { path: filename });
                    } catch {
                        this.ragIndex.removeFile(absolutePath);
                        log.debug('Removed from index', { path: filename });
                    }
                } else {
                    await this.ragIndex.reindexFile(absolutePath);
                    log.debug('Re-indexed', { path: filename });
                }
            } catch (err: any) {
                log.debug('Re-index failed', { path: filename, error: err.message });
            }
        }, 500));
    }
}
