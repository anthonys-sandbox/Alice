import { createLogger } from '../utils/logger.js';
import type { Agent } from '../runtime/agent.js';
import type { GoogleChatAdapter } from '../channels/google-chat.js';
import { EventEmitter } from 'events';

const log = createLogger('TaskQueue');

// ── Types ───────────────────────────────────────────────────

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface BackgroundTask {
    id: string;
    description: string;
    status: TaskStatus;
    progress: string;
    result: string;
    createdAt: string;
    completedAt?: string;
    toolsUsed: string[];
}

// ── Task Queue ──────────────────────────────────────────────

export class TaskQueue extends EventEmitter {
    private tasks = new Map<string, BackgroundTask>();
    private agent: Agent | null = null;
    private chat: GoogleChatAdapter | null = null;
    private maxConcurrent = 2;
    private running = 0;

    initialize(agent: Agent, chat: GoogleChatAdapter): void {
        this.agent = agent;
        this.chat = chat;
        log.info('Task queue initialized');
    }

    /**
     * Submit a new background task.
     * Returns immediately with the task ID — work happens async.
     */
    submit(description: string): BackgroundTask {
        const task: BackgroundTask = {
            id: `task_${Date.now().toString(36)}`,
            description,
            status: 'queued',
            progress: 'Waiting to start…',
            result: '',
            createdAt: new Date().toISOString(),
            toolsUsed: [],
        };

        this.tasks.set(task.id, task);
        log.info('Task queued', { id: task.id, description: description.slice(0, 80) });

        // Start processing if capacity available
        this.processNext();

        return task;
    }

    /** Process next queued task */
    private async processNext(): Promise<void> {
        if (this.running >= this.maxConcurrent) return;
        if (!this.agent || !this.chat) return;

        // Find next queued task
        const queued = [...this.tasks.values()].find(t => t.status === 'queued');
        if (!queued) return;

        this.running++;
        queued.status = 'running';
        queued.progress = 'Processing…';

        try {
            const response = await this.agent.processBackgroundMessage(
                `BACKGROUND TASK: ${queued.description}\n\nComplete this task thoroughly. Use whatever tools are needed. When done, provide a clear summary of what was accomplished.`,
                { useMainProvider: true },
            );

            queued.status = 'completed';
            queued.result = response.text;
            queued.completedAt = new Date().toISOString();
            queued.toolsUsed = response.toolsUsed || [];
            queued.progress = 'Done';

            log.info('Task completed', { id: queued.id });

            // Notify user
            await this.chat.sendCard(
                `✅ Background Task Complete`,
                queued.description.slice(0, 60),
                queued.result.slice(0, 800),
            );
        } catch (err: any) {
            queued.status = 'failed';
            queued.result = `Error: ${err.message}`;
            queued.completedAt = new Date().toISOString();
            queued.progress = 'Failed';

            log.error('Task failed', { id: queued.id, error: err.message });

            await this.chat?.sendCard(
                `❌ Background Task Failed`,
                queued.description.slice(0, 60),
                `Error: ${err.message}`,
            ).catch(() => { });
        } finally {
            this.running--;
            this.processNext();
        }
    }

    /** Get task by ID */
    getTask(id: string): BackgroundTask | undefined {
        return this.tasks.get(id);
    }

    /** List all tasks */
    listTasks(): BackgroundTask[] {
        return [...this.tasks.values()].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
    }

    /** Clean up old completed tasks (keep last 20) */
    cleanup(): void {
        const completed = this.listTasks().filter(t => t.status === 'completed' || t.status === 'failed');
        if (completed.length > 20) {
            const toRemove = completed.slice(20);
            for (const t of toRemove) {
                this.tasks.delete(t.id);
            }
        }
    }
}

// Singleton
export const taskQueue = new TaskQueue();
