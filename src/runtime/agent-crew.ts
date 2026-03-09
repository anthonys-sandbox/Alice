import { SubAgent, type SubAgentTask, type SubAgentResult } from './sub-agent.js';
import { createLogger } from '../utils/logger.js';
import type { AliceConfig } from '../utils/config.js';
import type { GeminiProvider } from './providers/gemini.js';
import type { OAIProvider } from './providers/oai-provider.js';
import Database from 'better-sqlite3';
import { join } from 'path';

const log = createLogger('AgentCrew');

// ── Types ───────────────────────────────────────────────────

export interface CrewStep {
    name: string;
    role: string;
    prompt: string;
    tools?: string[];
    /** Output from this step is stored under this key for downstream steps */
    outputKey: string;
    /** If true, this step can run in parallel with other parallel steps */
    parallel?: boolean;
}

export interface CrewPipeline {
    id: string;
    name: string;
    description: string;
    steps: CrewStep[];
    errorStrategy: 'abort' | 'skip' | 'retry';
}

export interface CrewRunStatus {
    pipelineId: string;
    pipelineName: string;
    status: 'running' | 'completed' | 'failed';
    startedAt: string;
    completedAt?: string;
    currentStep: number;
    totalSteps: number;
    steps: Array<{
        name: string;
        status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
        startedAt?: string;
        completedAt?: string;
        outputPreview?: string;
    }>;
    finalOutput?: string;
    error?: string;
}

// ── Pre-built Pipeline Templates ────────────────────────────

export const PIPELINE_TEMPLATES: Omit<CrewPipeline, 'id'>[] = [
    {
        name: 'Research & Report',
        description: 'Multi-phase research: gather data → analyze → draft a report → format for delivery.',
        errorStrategy: 'retry',
        steps: [
            {
                name: 'Research',
                role: 'Research Analyst',
                prompt: 'You are a thorough research analyst. Gather comprehensive information on the topic using available tools (web search, knowledge base, email, calendar, documents). Focus on facts, data points, and source attribution.\n\nTopic: {{input}}',
                tools: ['deep_research', 'web_search', 'search_knowledge', 'mcp_google-drive_search-files'],
                outputKey: 'research',
            },
            {
                name: 'Analyze',
                role: 'Strategic Analyst',
                prompt: 'You are a strategic analyst. Analyze the research findings below. Identify key themes, patterns, insights, and actionable takeaways. Highlight risks and opportunities.\n\nResearch:\n{{research}}',
                outputKey: 'analysis',
            },
            {
                name: 'Draft Report',
                role: 'Technical Writer',
                prompt: 'You are a professional technical writer. Using the analysis below, draft a polished executive report. Include:\n- Executive summary (2-3 sentences)\n- Key findings\n- Analysis & implications\n- Recommendations\n- Next steps\n\nAnalysis:\n{{analysis}}',
                outputKey: 'report',
            },
        ],
    },
    {
        name: 'Email Triage',
        description: 'Scan inbox → classify by priority → draft responses for urgent items → queue for approval.',
        errorStrategy: 'skip',
        steps: [
            {
                name: 'Scan Inbox',
                role: 'Email Scanner',
                prompt: 'You are an email triage specialist. Scan the recent inbox and list all unread emails with: sender, subject, received time, and a brief 1-sentence summary of each.\n\nInstructions: {{input}}',
                tools: ['mcp_google-gmail_search-emails', 'mcp_google-gmail_get-email'],
                outputKey: 'inbox_scan',
            },
            {
                name: 'Classify',
                role: 'Priority Classifier',
                prompt: 'You are a priority classifier. Categorize each email into: 🔴 URGENT (needs response today), 🟡 IMPORTANT (needs response this week), 🟢 FYI (no action needed), 🔵 NEWSLETTER (can archive). Format as a structured list.\n\nEmails:\n{{inbox_scan}}',
                outputKey: 'classified',
            },
            {
                name: 'Draft Replies',
                role: 'Email Composer',
                prompt: 'You are a professional email composer. For each URGENT and IMPORTANT email below, draft a concise, professional reply. Match the tone of the original sender. If you need approval before sending, note that.\n\nClassified emails:\n{{classified}}',
                outputKey: 'drafts',
            },
        ],
    },
    {
        name: 'Code Review',
        description: 'Fetch PR changes → analyze code quality → write review comments → post feedback.',
        errorStrategy: 'abort',
        steps: [
            {
                name: 'Fetch Changes',
                role: 'Code Reader',
                prompt: 'You are a code reviewer. Fetch the pull request or code changes described below and summarize what changed, including file-by-file diffs.\n\nRequest: {{input}}',
                tools: ['mcp_github_get-pull-request', 'mcp_github_list-pull-request-files'],
                outputKey: 'changes',
            },
            {
                name: 'Analyze Code',
                role: 'Senior Engineer',
                prompt: 'You are a senior engineer performing a code review. Analyze the code changes below for:\n- Bugs or logic errors\n- Security vulnerabilities\n- Performance issues\n- Code style violations\n- Missing edge cases\n- Opportunities for improvement\n\nBe specific and reference line numbers where possible.\n\nChanges:\n{{changes}}',
                outputKey: 'review',
            },
            {
                name: 'Format Review',
                role: 'Technical Writer',
                prompt: 'Format the code review findings below into a clear, constructive PR review comment. Use markdown with sections for Critical Issues, Suggestions, and Positive Notes. Be encouraging but thorough.\n\nReview findings:\n{{review}}',
                outputKey: 'formatted_review',
            },
        ],
    },
    {
        name: 'Content Pipeline',
        description: 'Research → outline → draft content → edit for quality → final polish.',
        errorStrategy: 'retry',
        steps: [
            {
                name: 'Research',
                role: 'Content Researcher',
                prompt: 'Research the topic below. Find relevant examples, statistics, expert opinions, and supporting material.\n\nTopic: {{input}}',
                tools: ['deep_research', 'web_search'],
                outputKey: 'research',
            },
            {
                name: 'Outline',
                role: 'Content Strategist',
                prompt: 'Create a detailed outline for a piece of content based on the research below. Include sections, key points, supporting evidence, and a suggested hook/introduction.\n\nResearch:\n{{research}}',
                outputKey: 'outline',
            },
            {
                name: 'Draft',
                role: 'Content Writer',
                prompt: 'Write a complete first draft following the outline below. Make it engaging, informative, and well-structured. Use clear language and include transitions between sections.\n\nOutline:\n{{outline}}',
                outputKey: 'draft',
            },
            {
                name: 'Edit',
                role: 'Editor',
                prompt: 'Edit the draft below for clarity, conciseness, grammar, and flow. Fix any factual errors, improve weak transitions, and ensure consistent tone. Return the fully edited version.\n\nDraft:\n{{draft}}',
                outputKey: 'final',
            },
        ],
    },
];

// ── Agent Crew Orchestrator ─────────────────────────────────

export class AgentCrew {
    private db: Database.Database;
    private activeRuns = new Map<string, CrewRunStatus>();

    constructor(
        private config: AliceConfig,
        private primaryProvider: any,
        private backgroundProvider: any,
        dataDir: string,
    ) {
        this.db = new Database(join(dataDir, 'crews.db'));
        this.db.pragma('journal_mode = WAL');
        this.ensureTables();
    }

    private ensureTables(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS crew_runs (
                id TEXT PRIMARY KEY,
                pipeline_id TEXT NOT NULL,
                pipeline_name TEXT NOT NULL,
                status TEXT DEFAULT 'running',
                started_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT,
                total_steps INTEGER,
                steps_json TEXT DEFAULT '[]',
                final_output TEXT,
                error TEXT,
                input TEXT
            );

            CREATE TABLE IF NOT EXISTS custom_pipelines (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                steps_json TEXT NOT NULL,
                error_strategy TEXT DEFAULT 'retry',
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_runs_status ON crew_runs(status);
            CREATE INDEX IF NOT EXISTS idx_runs_time ON crew_runs(started_at);
        `);
    }

    // ── Pipeline Execution ──────────────────────────────────

    /** Execute a pipeline with the given input */
    async execute(pipeline: CrewPipeline, input: string): Promise<CrewRunStatus> {
        const runId = `crew_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

        const run: CrewRunStatus = {
            pipelineId: pipeline.id,
            pipelineName: pipeline.name,
            status: 'running',
            startedAt: new Date().toISOString(),
            currentStep: 0,
            totalSteps: pipeline.steps.length,
            steps: pipeline.steps.map(s => ({
                name: s.name,
                status: 'pending' as const,
            })),
        };

        this.activeRuns.set(runId, run);
        this.saveRun(runId, run, input);

        log.info(`Starting crew pipeline: ${pipeline.name}`, { runId, steps: pipeline.steps.length });

        // Build context map — starts with user input
        const context: Record<string, string> = { input };

        try {
            for (let i = 0; i < pipeline.steps.length; i++) {
                const step = pipeline.steps[i];
                run.currentStep = i;
                run.steps[i].status = 'running';
                run.steps[i].startedAt = new Date().toISOString();
                this.saveRun(runId, run, input);

                log.info(`Crew step ${i + 1}/${pipeline.steps.length}: ${step.name}`, { role: step.role });

                // Substitute context variables in the prompt
                let resolvedPrompt = step.prompt;
                for (const [key, val] of Object.entries(context)) {
                    resolvedPrompt = resolvedPrompt.replace(new RegExp(`{{${key}}}`, 'g'), val);
                }

                // Build role-specific system prompt
                const systemPrompt = `You are ${step.role}. Complete the task below thoroughly and professionally. Be detailed and specific in your output.`;

                let result: SubAgentResult;
                let retries = 0;
                const maxRetries = pipeline.errorStrategy === 'retry' ? 2 : 0;

                while (true) {
                    try {
                        const toolSet = step.tools
                            ? new Set(step.tools)
                            : undefined;

                        const subAgent = new SubAgent(
                            this.config,
                            this.primaryProvider,
                            this.backgroundProvider,
                            toolSet || new Set<string>(),
                        );

                        result = await subAgent.execute({
                            task: resolvedPrompt,
                            tools: step.tools,
                            maxIterations: 15,
                            provider: 'primary',
                        });

                        if (!result.success && retries < maxRetries) {
                            retries++;
                            log.warn(`Crew step "${step.name}" failed, retrying (${retries}/${maxRetries})`);
                            continue;
                        }

                        break;
                    } catch (err: any) {
                        if (retries < maxRetries) {
                            retries++;
                            log.warn(`Crew step "${step.name}" threw error, retrying (${retries}/${maxRetries})`, { error: err.message });
                            continue;
                        }
                        result = { text: '', toolsUsed: [], iterations: 0, success: false, error: err.message };
                        break;
                    }
                }

                // Handle step result
                if (result.success) {
                    run.steps[i].status = 'completed';
                    run.steps[i].completedAt = new Date().toISOString();
                    run.steps[i].outputPreview = result.text.slice(0, 300);
                    context[step.outputKey] = result.text;
                } else {
                    if (pipeline.errorStrategy === 'abort') {
                        run.steps[i].status = 'failed';
                        run.status = 'failed';
                        run.error = `Step "${step.name}" failed: ${result.error || 'Unknown error'}`;
                        // Mark remaining steps as skipped
                        for (let j = i + 1; j < pipeline.steps.length; j++) {
                            run.steps[j].status = 'skipped';
                        }
                        this.saveRun(runId, run, input);
                        this.activeRuns.delete(runId);
                        return run;
                    }
                    // Skip strategy — continue to next step
                    run.steps[i].status = 'failed';
                    run.steps[i].outputPreview = result.error || 'Step failed';
                    context[step.outputKey] = `[Step "${step.name}" failed: ${result.error || 'unknown error'}]`;
                }

                this.saveRun(runId, run, input);
            }

            // Pipeline complete — use the last step's output as final
            const lastKey = pipeline.steps[pipeline.steps.length - 1].outputKey;
            run.finalOutput = context[lastKey] || '';
            run.status = 'completed';
            run.completedAt = new Date().toISOString();
            this.saveRun(runId, run, input);
            this.activeRuns.delete(runId);

            log.info(`Crew pipeline completed: ${pipeline.name}`, { runId });
            return run;
        } catch (err: any) {
            run.status = 'failed';
            run.error = err.message;
            run.completedAt = new Date().toISOString();
            this.saveRun(runId, run, input);
            this.activeRuns.delete(runId);
            log.error(`Crew pipeline failed: ${pipeline.name}`, { error: err.message });
            return run;
        }
    }

    // ── Pipeline Management ─────────────────────────────────

    /** Get all pre-built + custom pipeline templates */
    listPipelines(): CrewPipeline[] {
        const builtIn = PIPELINE_TEMPLATES.map((t, i) => ({
            ...t,
            id: `builtin_${i}`,
        }));

        const custom = (this.db.prepare('SELECT * FROM custom_pipelines ORDER BY created_at DESC').all() as any[]).map(row => ({
            id: row.id,
            name: row.name,
            description: row.description,
            steps: JSON.parse(row.steps_json),
            errorStrategy: row.error_strategy as 'abort' | 'skip' | 'retry',
        }));

        return [...builtIn, ...custom];
    }

    /** Get a pipeline by ID */
    getPipeline(id: string): CrewPipeline | undefined {
        if (id.startsWith('builtin_')) {
            const idx = parseInt(id.replace('builtin_', ''), 10);
            if (idx >= 0 && idx < PIPELINE_TEMPLATES.length) {
                return { ...PIPELINE_TEMPLATES[idx], id };
            }
        }
        const row = this.db.prepare('SELECT * FROM custom_pipelines WHERE id = ?').get(id) as any;
        if (!row) return undefined;
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            steps: JSON.parse(row.steps_json),
            errorStrategy: row.error_strategy,
        };
    }

    /** Create a custom pipeline */
    createPipeline(pipeline: Omit<CrewPipeline, 'id'>): CrewPipeline {
        const id = `custom_${Date.now().toString(36)}`;
        this.db.prepare(
            'INSERT INTO custom_pipelines (id, name, description, steps_json, error_strategy) VALUES (?, ?, ?, ?, ?)'
        ).run(id, pipeline.name, pipeline.description, JSON.stringify(pipeline.steps), pipeline.errorStrategy);
        return { ...pipeline, id };
    }

    /** Delete a custom pipeline */
    deletePipeline(id: string): boolean {
        if (id.startsWith('builtin_')) return false; // Can't delete built-ins
        const result = this.db.prepare('DELETE FROM custom_pipelines WHERE id = ?').run(id);
        return result.changes > 0;
    }

    // ── Run History ─────────────────────────────────────────

    /** Get recent pipeline runs */
    getRunHistory(limit: number = 20): CrewRunStatus[] {
        return (this.db.prepare('SELECT * FROM crew_runs ORDER BY started_at DESC LIMIT ?').all(limit) as any[]).map(r => ({
            pipelineId: r.pipeline_id,
            pipelineName: r.pipeline_name,
            status: r.status,
            startedAt: r.started_at,
            completedAt: r.completed_at,
            currentStep: r.total_steps, // Historical runs show all steps
            totalSteps: r.total_steps,
            steps: JSON.parse(r.steps_json || '[]'),
            finalOutput: r.final_output,
            error: r.error,
        }));
    }

    /** Get actively running pipelines */
    getActiveRuns(): CrewRunStatus[] {
        return Array.from(this.activeRuns.values());
    }

    // ── Persistence ─────────────────────────────────────────

    private saveRun(runId: string, run: CrewRunStatus, input: string): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO crew_runs (id, pipeline_id, pipeline_name, status, started_at, completed_at, total_steps, steps_json, final_output, error, input)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            runId, run.pipelineId, run.pipelineName, run.status,
            run.startedAt, run.completedAt || null, run.totalSteps,
            JSON.stringify(run.steps), run.finalOutput || null, run.error || null, input,
        );
    }

    close(): void {
        this.db.close();
    }
}
