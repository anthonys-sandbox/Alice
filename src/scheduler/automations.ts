import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as cron from 'node-cron';
import { createLogger } from '../utils/logger.js';
import type { Agent } from '../runtime/agent.js';
import type { GoogleChatAdapter } from '../channels/google-chat.js';

const log = createLogger('Automations');

// ── Types ───────────────────────────────────────────────────

export type TriggerType = 'on_cron' | 'on_keyword' | 'on_file_change' | 'on_schedule';

export interface AutomationRule {
    id: string;
    name: string;
    description: string;
    trigger: {
        type: TriggerType;
        /** Cron expression for on_cron, keyword string for on_keyword, path for on_file_change, or time for on_schedule */
        value: string;
    };
    condition?: string;           // Optional natural-language condition
    action: {
        type: 'run_prompt' | 'execute_tool' | 'send_notification';
        /** Prompt text, tool name, or notification message */
        value: string;
        toolArgs?: Record<string, any>;
    };
    enabled: boolean;
    createdAt: string;
    lastRun?: string;
    runCount: number;
}

// ── Automation Manager ──────────────────────────────────────

export class AutomationManager {
    private rules: AutomationRule[] = [];
    private cronTasks = new Map<string, ReturnType<typeof cron.schedule>>();
    private filePath: string;
    private agent: Agent | null = null;
    private chat: GoogleChatAdapter | null = null;

    constructor(memoryDir: string) {
        this.filePath = join(memoryDir, 'automations.json');
        this.loadRules();
    }

    /** Load rules from disk */
    private loadRules(): void {
        try {
            if (existsSync(this.filePath)) {
                this.rules = JSON.parse(readFileSync(this.filePath, 'utf-8'));
            }
        } catch (err: any) {
            log.warn('Failed to load automations', { error: err.message });
            this.rules = [];
        }
    }

    /** Save rules to disk */
    private saveRules(): void {
        writeFileSync(this.filePath, JSON.stringify(this.rules, null, 2), 'utf-8');
    }

    /** Start all enabled cron-based automations */
    start(agent: Agent, chat: GoogleChatAdapter): void {
        this.agent = agent;
        this.chat = chat;

        for (const rule of this.rules) {
            if (rule.enabled && rule.trigger.type === 'on_cron') {
                this.startCronRule(rule);
            }
        }

        log.info(`Automations started: ${this.rules.filter(r => r.enabled).length} active`);
    }

    /** Stop all cron tasks */
    stop(): void {
        for (const [, task] of this.cronTasks) {
            task.stop();
        }
        this.cronTasks.clear();
    }

    /** Start a cron rule */
    private startCronRule(rule: AutomationRule): void {
        try {
            const task = cron.schedule(rule.trigger.value, async () => {
                await this.executeRule(rule);
            });
            this.cronTasks.set(rule.id, task);
        } catch (err: any) {
            log.warn(`Failed to start cron rule: ${rule.name}`, { error: err.message });
        }
    }

    /** Execute a single rule */
    async executeRule(rule: AutomationRule): Promise<string> {
        if (!this.agent || !this.chat) return 'Automation not initialized';

        log.info(`Executing automation: ${rule.name}`);

        try {
            let result = '';

            switch (rule.action.type) {
                case 'run_prompt': {
                    const response = await this.agent.processBackgroundMessage(
                        rule.action.value,
                        { useMainProvider: true },
                    );
                    result = response.text;

                    // Send result as notification
                    if (result && result.trim()) {
                        await this.chat.sendCard(
                            `⚡ Automation: ${rule.name}`,
                            new Date().toLocaleString(),
                            result.slice(0, 800),
                        );
                    }
                    break;
                }

                case 'send_notification': {
                    await this.chat.sendCard(
                        `⚡ Automation: ${rule.name}`,
                        new Date().toLocaleString(),
                        rule.action.value,
                    );
                    result = 'Notification sent';
                    break;
                }

                case 'execute_tool': {
                    // Run a specific tool with args
                    const response = await this.agent.processBackgroundMessage(
                        `Use the ${rule.action.value} tool with these parameters: ${JSON.stringify(rule.action.toolArgs || {})}`,
                        { useMainProvider: false },
                    );
                    result = response.text;
                    break;
                }
            }

            // Update rule stats
            rule.lastRun = new Date().toISOString();
            rule.runCount++;
            this.saveRules();

            return result;
        } catch (err: any) {
            log.error(`Automation failed: ${rule.name}`, { error: err.message });
            return `Error: ${err.message}`;
        }
    }

    /** Check keyword triggers against a message */
    async checkKeywordTriggers(message: string): Promise<void> {
        const msg = message.toLowerCase();
        for (const rule of this.rules) {
            if (!rule.enabled || rule.trigger.type !== 'on_keyword') continue;
            if (msg.includes(rule.trigger.value.toLowerCase())) {
                await this.executeRule(rule);
            }
        }
    }

    // ── CRUD ────────────────────────────────────────────────

    addRule(rule: Omit<AutomationRule, 'id' | 'createdAt' | 'runCount'>): AutomationRule {
        const newRule: AutomationRule = {
            ...rule,
            id: `auto_${Date.now().toString(36)}`,
            createdAt: new Date().toISOString(),
            runCount: 0,
        };
        this.rules.push(newRule);
        this.saveRules();

        // Start cron if applicable
        if (newRule.enabled && newRule.trigger.type === 'on_cron' && this.agent) {
            this.startCronRule(newRule);
        }

        log.info(`Automation created: ${newRule.name}`, { id: newRule.id });
        return newRule;
    }

    removeRule(id: string): boolean {
        const idx = this.rules.findIndex(r => r.id === id);
        if (idx < 0) return false;

        // Stop cron if active
        const task = this.cronTasks.get(id);
        if (task) {
            task.stop();
            this.cronTasks.delete(id);
        }

        this.rules.splice(idx, 1);
        this.saveRules();
        return true;
    }

    toggleRule(id: string): boolean | null {
        const rule = this.rules.find(r => r.id === id);
        if (!rule) return null;

        rule.enabled = !rule.enabled;
        this.saveRules();

        if (rule.enabled && rule.trigger.type === 'on_cron' && this.agent) {
            this.startCronRule(rule);
        } else {
            const task = this.cronTasks.get(id);
            if (task) {
                task.stop();
                this.cronTasks.delete(id);
            }
        }

        return rule.enabled;
    }

    listRules(): AutomationRule[] {
        return [...this.rules];
    }

    getRule(id: string): AutomationRule | undefined {
        return this.rules.find(r => r.id === id);
    }
}
