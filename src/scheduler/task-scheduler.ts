import * as cron from 'node-cron';
import { watch as fsWatch, type FSWatcher } from 'fs';
import { createLogger } from '../utils/logger.js';
import type { Agent } from '../runtime/agent.js';

const log = createLogger('Scheduler');

interface Reminder {
    id: string;
    message: string;
    cronExpr: string;
    task: ReturnType<typeof cron.schedule>;
    oneShot: boolean;
}

interface FileWatch {
    id: string;
    path: string;
    watcher: FSWatcher;
}

/**
 * Manages user-defined reminders and file watchers.
 * Completely free — uses node-cron (already a dep) and fs.watch (built-in).
 */
export class TaskScheduler {
    private reminders = new Map<string, Reminder>();
    private fileWatches = new Map<string, FileWatch>();
    private agent: Agent | null = null;
    private notifyCallback: ((msg: string) => void) | null = null;

    setAgent(agent: Agent) {
        this.agent = agent;
    }

    setNotifyCallback(cb: (msg: string) => void) {
        this.notifyCallback = cb;
    }

    /**
     * Schedule a reminder. Supports:
     * - "in 5m" / "in 2h" — one-shot relative reminders
     * - Cron expressions — recurring
     */
    addReminder(message: string, schedule: string): string {
        const id = `rem_${Date.now().toString(36)}`;

        // Parse relative time: "in 5m", "in 2h", "in 30s"
        const relativeMatch = schedule.match(/^in\s+(\d+)\s*(s|m|h)$/i);
        if (relativeMatch) {
            const amount = parseInt(relativeMatch[1], 10);
            const unit = relativeMatch[2].toLowerCase();
            const ms = unit === 's' ? amount * 1000 : unit === 'm' ? amount * 60000 : amount * 3600000;

            const timeout = setTimeout(() => {
                this.fireReminder(id, message);
                this.reminders.delete(id);
            }, ms);

            this.reminders.set(id, {
                id,
                message,
                cronExpr: schedule,
                task: { stop: () => clearTimeout(timeout) } as any,
                oneShot: true,
            });

            log.info(`Reminder set: "${message}" ${schedule}`, { id });
            return id;
        }

        // Cron expression
        if (!cron.validate(schedule)) {
            throw new Error(`Invalid schedule: "${schedule}". Use "in 5m", "in 2h", or a cron expression.`);
        }

        const task = cron.schedule(schedule, () => {
            this.fireReminder(id, message);
        });

        this.reminders.set(id, { id, message, cronExpr: schedule, task, oneShot: false });
        log.info(`Recurring reminder set: "${message}" (${schedule})`, { id });
        return id;
    }

    /**
     * Cancel a reminder by ID.
     */
    cancelReminder(id: string): boolean {
        const reminder = this.reminders.get(id);
        if (!reminder) return false;
        reminder.task.stop();
        this.reminders.delete(id);
        log.info('Reminder cancelled', { id });
        return true;
    }

    /**
     * List active reminders.
     */
    listReminders(): Array<{ id: string; message: string; schedule: string; oneShot: boolean }> {
        return Array.from(this.reminders.values()).map(r => ({
            id: r.id,
            message: r.message,
            schedule: r.cronExpr,
            oneShot: r.oneShot,
        }));
    }

    /**
     * Watch a file or directory for changes.
     */
    watchFile(filePath: string, description: string): string {
        const id = `watch_${Date.now().toString(36)}`;

        const watcher = fsWatch(filePath, { persistent: false }, (eventType, filename) => {
            const msg = `📂 File change detected: ${eventType} on ${filename || filePath} — ${description}`;
            log.info(msg);
            this.notifyCallback?.(msg);
        });

        this.fileWatches.set(id, { id, path: filePath, watcher });
        log.info(`File watcher registered: ${filePath}`, { id, description });
        return id;
    }

    /**
     * Stop watching a file.
     */
    unwatchFile(id: string): boolean {
        const fw = this.fileWatches.get(id);
        if (!fw) return false;
        fw.watcher.close();
        this.fileWatches.delete(id);
        log.info('File watcher removed', { id });
        return true;
    }

    /**
     * List active file watchers.
     */
    listWatchers(): Array<{ id: string; path: string }> {
        return Array.from(this.fileWatches.values()).map(fw => ({
            id: fw.id,
            path: fw.path,
        }));
    }

    /**
     * Stop all reminders and watchers.
     */
    stopAll(): void {
        for (const r of this.reminders.values()) r.task.stop();
        this.reminders.clear();
        for (const fw of this.fileWatches.values()) fw.watcher.close();
        this.fileWatches.clear();
        log.info('All scheduled tasks stopped');
    }

    private fireReminder(id: string, message: string) {
        const msg = `⏰ Reminder: ${message}`;
        log.info(msg, { id });
        this.notifyCallback?.(msg);
    }
}

// Singleton
export const scheduler = new TaskScheduler();
