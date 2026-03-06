import { SubAgent, type SubAgentResult } from './sub-agent.js';
import { executeTool, toolEvents } from './tools/registry.js';
import { createLogger } from '../utils/logger.js';
import { execSync } from 'child_process';
import type { AliceConfig } from '../utils/config.js';

const log = createLogger('CodingAgent');

export interface CodingTask {
    task: string;
    files?: string[];         // Specific files to focus on
    autoApply?: boolean;      // Skip review and auto-apply (default: false)
    maxIterations?: number;   // Max iterations for the coding loop (default: 15)
}

export interface CodingResult {
    text: string;             // Summary of what was done
    diff: string;             // Unified diff of all changes
    filesChanged: string[];   // List of files that were changed
    success: boolean;
    iterations: number;
    error?: string;
}

/**
 * A specialized agent for autonomous coding tasks.
 * Workflow: git stash → plan → edit → build/test → review diff → (approve/rollback)
 */
export class CodingAgent {
    private config: AliceConfig;
    private primaryProvider: any;
    private backgroundProvider: any;

    constructor(config: AliceConfig, primaryProvider: any, backgroundProvider: any) {
        this.config = config;
        this.primaryProvider = primaryProvider;
        this.backgroundProvider = backgroundProvider;
    }

    /**
     * Execute a coding task with safety measures.
     */
    async execute(task: CodingTask): Promise<CodingResult> {
        const cwd = process.cwd();
        const maxIter = task.maxIterations ?? 15;

        log.info('Coding agent started', { task: task.task.slice(0, 100) });

        toolEvents.emit('tool_output', {
            tool: 'code',
            stream: 'info',
            chunk: `🔨 Coding agent started: ${task.task.slice(0, 100)}`,
            command: task.task,
        });

        // Step 1: Save current state (git stash)
        let stashCreated = false;
        const stashName = `alice-coding-agent-${Date.now()}`;
        try {
            const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8' }).trim();
            if (status) {
                execSync(`git stash push -m "${stashName}"`, { cwd, encoding: 'utf-8' });
                stashCreated = true;
                log.info('Created git stash backup');
                toolEvents.emit('tool_output', {
                    tool: 'code',
                    stream: 'info',
                    chunk: '  📦 Saved working tree to git stash',
                    command: task.task,
                });
            }
        } catch (err: any) {
            log.warn('Git stash failed — proceeding without backup', { error: err.message });
        }

        try {
            // Step 2: Build the coding prompt
            const fileContext = task.files?.length
                ? `\nFocus on these files: ${task.files.join(', ')}`
                : '';

            const codingPrompt = [
                `CODING TASK: ${task.task}`,
                fileContext,
                '',
                'Instructions:',
                '1. First use search_codebase or read_file to understand the relevant code',
                '2. Plan your changes (mention what files you\'ll modify and why)',
                '3. Make the changes using write_file or edit_file',
                '4. Run "npx tsc --noEmit" with bash to verify the build',
                '5. If the build fails, fix the errors and retry',
                '6. When done, summarize what you changed and why',
                '',
                'IMPORTANT: Make small, targeted changes. Test after each change.',
            ].join('\n');

            // Step 3: Run the sub-agent with coding tools
            const codingTools = new Set([
                'bash', 'read_file', 'write_file', 'edit_file',
                'search_codebase', 'list_directory',
            ]);

            const subAgent = new SubAgent(
                this.config,
                this.primaryProvider,
                this.backgroundProvider,
                codingTools,
            );

            // Use primary provider for coding (needs higher capability)
            const result = await subAgent.execute({
                task: codingPrompt,
                tools: [...codingTools],
                maxIterations: maxIter,
                provider: 'primary',
            });

            // Step 4: Get the diff
            let diff = '';
            let filesChanged: string[] = [];
            try {
                diff = execSync('git diff', { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
                if (!diff.trim()) {
                    diff = execSync('git diff --cached', { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
                }
                const changedFiles = execSync('git diff --name-only', { cwd, encoding: 'utf-8' }).trim();
                filesChanged = changedFiles ? changedFiles.split('\n') : [];
            } catch {
                log.debug('Could not get diff');
            }

            toolEvents.emit('tool_output', {
                tool: 'code',
                stream: 'info',
                chunk: `✅ Coding agent finished (${result.iterations} iterations, ${filesChanged.length} files changed)`,
                command: task.task,
            });

            return {
                text: result.text,
                diff: diff.length > 10000 ? diff.slice(0, 10000) + '\n... (truncated)' : diff,
                filesChanged,
                success: result.success,
                iterations: result.iterations,
                error: result.error,
            };
        } catch (err: any) {
            // On failure, offer rollback
            log.error('Coding agent failed', { error: err.message });

            if (stashCreated) {
                toolEvents.emit('tool_output', {
                    tool: 'code',
                    stream: 'stderr',
                    chunk: '⚠️ Coding agent failed — you can rollback with: git checkout . && git stash pop',
                    command: task.task,
                });
            }

            return {
                text: `Coding agent failed: ${err.message}`,
                diff: '',
                filesChanged: [],
                success: false,
                iterations: 0,
                error: err.message,
            };
        }
    }

    /**
     * Rollback changes made by the coding agent.
     */
    rollback(): string {
        const cwd = process.cwd();
        try {
            // Discard the coding agent's changes
            execSync('git checkout .', { cwd, encoding: 'utf-8' });

            // Try to restore the user's original stash (most recent alice stash)
            try {
                const stashList = execSync('git stash list', { cwd, encoding: 'utf-8' });
                const lines = stashList.split('\n');
                const aliceStash = lines.find(l => l.includes('alice-coding-agent-'));
                if (aliceStash) {
                    const stashRef = aliceStash.split(':')[0]; // e.g., stash@{0}
                    execSync(`git stash pop ${stashRef}`, { cwd, encoding: 'utf-8' });
                    return 'Changes rolled back and your previous state restored from stash.';
                }
            } catch { /* no stash to pop */ }

            return 'Changes rolled back (git checkout .).';
        } catch (err: any) {
            return `Rollback failed: ${err.message}`;
        }
    }
}
