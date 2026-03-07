import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { createLogger } from '../utils/logger.js';
import { executeTool } from './tools/registry.js';

const log = createLogger('PlaybookEngine');

// ── Types ──────────────────────────────────────────────────

export interface PlaybookStep {
    /** Tool name to execute */
    tool: string;
    /** Tool arguments — supports {{variable}} interpolation */
    args: Record<string, any>;
    /** Store this step's output in a named variable for later steps */
    output_var?: string;
    /** Optional description of what this step does */
    description?: string;
    /** If true, continue even if this step fails */
    continue_on_error?: boolean;
}

export interface Playbook {
    /** Unique playbook name (derived from filename) */
    name: string;
    /** Human-readable description */
    description: string;
    /** How the playbook is triggered: manual, keyword, schedule */
    trigger: 'manual' | 'keyword' | 'schedule';
    /** Keywords that can auto-trigger this playbook (for trigger=keyword) */
    keywords?: string[];
    /** Cron expression (for trigger=schedule) */
    schedule?: string;
    /** Ordered list of steps */
    steps: PlaybookStep[];
}

export interface PlaybookResult {
    name: string;
    success: boolean;
    stepsCompleted: number;
    stepsTotal: number;
    outputs: Record<string, string>;
    errors: string[];
    duration: number;
}

// ── Playbook Engine ────────────────────────────────────────

export class PlaybookEngine {
    private playbookDir: string;
    private cache = new Map<string, Playbook>();

    constructor(memoryDir: string) {
        this.playbookDir = join(memoryDir, 'playbooks');
        if (!existsSync(this.playbookDir)) {
            mkdirSync(this.playbookDir, { recursive: true });
        }
        this.loadAll();
    }

    /**
     * Load all playbooks from disk.
     */
    private loadAll(): void {
        this.cache.clear();
        try {
            const files = readdirSync(this.playbookDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const content = readFileSync(join(this.playbookDir, file), 'utf-8');
                    const pb = JSON.parse(content) as Playbook;
                    pb.name = pb.name || basename(file, '.json');
                    this.cache.set(pb.name, pb);
                } catch (err: any) {
                    log.warn('Failed to load playbook', { file, error: err.message });
                }
            }
            log.info(`Loaded ${this.cache.size} playbook(s)`, { dir: this.playbookDir });
        } catch {
            log.info('No playbooks directory yet');
        }
    }

    /**
     * List all available playbooks.
     */
    listPlaybooks(): Array<{ name: string; description: string; trigger: string; steps: number }> {
        this.loadAll(); // Refresh from disk
        return [...this.cache.values()].map(pb => ({
            name: pb.name,
            description: pb.description,
            trigger: pb.trigger,
            steps: pb.steps.length,
        }));
    }

    /**
     * Get a playbook by name.
     */
    getPlaybook(name: string): Playbook | null {
        this.loadAll();
        return this.cache.get(name) || null;
    }

    /**
     * Execute a playbook with the given input context.
     * Variables can be referenced in step args using {{variable_name}}.
     * Built-in variables: {{now}}, {{today}}, {{user}}.
     * Each step's output is stored as {{step_N}} or the step's output_var.
     */
    async executePlaybook(
        name: string,
        context: Record<string, string> = {}
    ): Promise<PlaybookResult> {
        const pb = this.getPlaybook(name);
        if (!pb) {
            return {
                name,
                success: false,
                stepsCompleted: 0,
                stepsTotal: 0,
                outputs: {},
                errors: [`Playbook "${name}" not found`],
                duration: 0,
            };
        }

        const startTime = Date.now();
        const variables: Record<string, string> = {
            ...context,
            now: new Date().toISOString(),
            today: new Date().toISOString().split('T')[0],
            user: 'Anthony',
        };
        const errors: string[] = [];
        let stepsCompleted = 0;

        log.info(`Executing playbook: ${name}`, { steps: pb.steps.length, context: Object.keys(context) });

        for (let i = 0; i < pb.steps.length; i++) {
            const step = pb.steps[i];
            const stepLabel = step.description || `Step ${i + 1}: ${step.tool}`;

            try {
                // Interpolate variables in args
                const resolvedArgs = this.interpolateArgs(step.args, variables);

                log.info(`  [${i + 1}/${pb.steps.length}] ${stepLabel}`, { tool: step.tool });

                // Execute the tool
                const result = await executeTool(step.tool, resolvedArgs);
                const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

                // Store output
                variables[`step_${i + 1}`] = resultStr;
                if (step.output_var) {
                    variables[step.output_var] = resultStr;
                }

                // Keep prev for simple {{prev}} references
                variables['prev'] = resultStr;

                stepsCompleted++;
            } catch (err: any) {
                const errorMsg = `Step ${i + 1} (${step.tool}) failed: ${err.message}`;
                log.warn(errorMsg);
                errors.push(errorMsg);

                // Store error as output so subsequent steps can reference it
                variables[`step_${i + 1}`] = `ERROR: ${err.message}`;
                if (step.output_var) variables[step.output_var] = `ERROR: ${err.message}`;
                variables['prev'] = `ERROR: ${err.message}`;

                if (!step.continue_on_error) {
                    log.warn(`Playbook "${name}" halted at step ${i + 1}`);
                    break;
                }
                stepsCompleted++; // Still count as completed if continue_on_error
            }
        }

        const duration = Date.now() - startTime;
        const success = stepsCompleted === pb.steps.length && errors.length === 0;

        log.info(`Playbook "${name}" ${success ? 'completed' : 'finished with errors'}`, {
            stepsCompleted,
            stepsTotal: pb.steps.length,
            errors: errors.length,
            duration: `${duration}ms`,
        });

        return {
            name,
            success,
            stepsCompleted,
            stepsTotal: pb.steps.length,
            outputs: variables,
            errors,
            duration,
        };
    }

    /**
     * Recursively interpolate {{variable}} placeholders in step arguments.
     */
    private interpolateArgs(args: Record<string, any>, vars: Record<string, string>): Record<string, any> {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(args)) {
            if (typeof value === 'string') {
                result[key] = value.replace(/\{\{(\w+)\}\}/g, (_, varName) => vars[varName] || '');
            } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                result[key] = this.interpolateArgs(value, vars);
            } else if (Array.isArray(value)) {
                result[key] = value.map(v =>
                    typeof v === 'string'
                        ? v.replace(/\{\{(\w+)\}\}/g, (_, varName) => vars[varName] || '')
                        : v
                );
            } else {
                result[key] = value;
            }
        }
        return result;
    }

    /**
     * Find playbooks that match a keyword trigger.
     */
    findByKeyword(text: string): Playbook[] {
        const lower = text.toLowerCase();
        return [...this.cache.values()]
            .filter(pb => pb.trigger === 'keyword' && pb.keywords?.some(kw => lower.includes(kw.toLowerCase())));
    }

    /**
     * Find playbooks with schedule triggers.
     */
    getScheduledPlaybooks(): Playbook[] {
        return [...this.cache.values()].filter(pb => pb.trigger === 'schedule' && pb.schedule);
    }
}
