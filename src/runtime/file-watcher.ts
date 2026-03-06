import { watch, FSWatcher } from 'fs';
import { join, extname, relative } from 'path';
import { readdirSync, statSync } from 'fs';
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
    'generated_images', '.alice',
]);

/**
 * Watches the project directory for file changes and triggers incremental
 * RAG re-indexing. Uses Node's native `fs.watch` with debouncing.
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
     * Start watching the project directory tree.
     */
    start(): void {
        if (this.running) return;
        this.running = true;

        try {
            // Watch the project root recursively (macOS supports recursive natively)
            const watcher = watch(this.projectRoot, { recursive: true }, (event, filename) => {
                if (!filename) return;
                this.handleChange(event, filename);
            });

            this.watchers.push(watcher);
            log.info('File watcher started', { root: this.projectRoot });
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
                        // File exists — re-index
                        await this.ragIndex.reindexFile(absolutePath);
                        log.debug('Re-indexed', { path: filename });
                    } catch {
                        // File deleted — remove from index
                        this.ragIndex.removeFile(absolutePath);
                        log.debug('Removed from index', { path: filename });
                    }
                } else {
                    // change event — re-index
                    await this.ragIndex.reindexFile(absolutePath);
                    log.debug('Re-indexed', { path: filename });
                }
            } catch (err: any) {
                log.debug('Re-index failed', { path: filename, error: err.message });
            }
        }, 500));
    }
}
