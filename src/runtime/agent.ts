import { GeminiProvider, type LLMMessage, type LLMPart, type LLMResponse, type FunctionDeclaration } from './providers/gemini.js';
import { OAIProvider } from './providers/oai-provider.js';
import { hasCliCredentials } from './providers/gemini-cli-auth.js';
import { getOpenAIAccessToken, getOpenAIAccessTokenSync, hasCodexCredentials } from './providers/openai-oauth.js';
import { executeTool, toGeminiFunctionDeclarations, registerTool, toolEvents } from './tools/registry.js';
import { loadMemory, buildSystemPrompt, appendDailyLog, appendFacts, updateMemory, searchMemoryFiles, setMemoryStore, getMemoryStore, type MemoryUpdate } from '../memory/index.js';
import { loadSkills, buildSkillPrompt, installSkill } from '../skills/loader.js';
import { SessionStore } from '../memory/sessions.js';
import { MemoryStore } from '../memory/memory-store.js';
import { RAGIndex } from '../memory/rag-index.js';
import { createLogger } from '../utils/logger.js';
import type { AliceConfig } from '../utils/config.js';
import { join } from 'path';

const log = createLogger('Agent');

/** Both providers expose the same generateContent signature. */
type ChatProvider = {
    generateContent(
        systemInstruction: string,
        messages: LLMMessage[],
        functionDeclarations: FunctionDeclaration[]
    ): Promise<LLMResponse>;
    generateContentStream?(
        systemInstruction: string,
        messages: LLMMessage[],
        functionDeclarations: FunctionDeclaration[],
        onToken: (token: string) => void
    ): Promise<LLMResponse>;
};

export interface AgentResponse {
    text: string;
    toolsUsed: string[];
    iterations: number;
}

export class Agent {
    private provider: ChatProvider;
    private fallbackProvider?: ChatProvider;
    private backgroundProvider: ChatProvider | null = null;
    private config: AliceConfig;
    private conversationHistory: LLMMessage[] = [];
    private systemPrompt: string = '';
    private sessionStore: SessionStore;
    private ragIndex: RAGIndex | null = null;
    private currentSessionId: string;
    public activeModel!: string;
    public activeProvider!: string;
    private usingFallback = false;

    // Usage tracking
    private sessionStats = {
        apiCalls: 0,
        toolCalls: 0,
        toolsUsed: {} as Record<string, number>,
        startTime: Date.now(),
    };
    private statsPersistTimer: ReturnType<typeof setTimeout> | null = null;

    // Background task throttling
    private lastExtractionTime = 0;
    private pendingExtractions: Array<{ userMessage: string; assistantResponse: string; toolsUsed: string[] }> = [];
    private extractionTimer: ReturnType<typeof setTimeout> | null = null;

    // Canvas: holds the last canvas payload pushed by the canvas tool
    private lastCanvasPayload: { html: string; title: string } | null = null;

    // Location: resolver for async geolocation requests via WebSocket
    private locationResolver: {
        resolve: (value: string) => void;
        timer: ReturnType<typeof setTimeout>;
    } | null = null;

    constructor(config: AliceConfig) {
        this.config = config;

        if (config.chatProvider === 'gemini') {
            log.info('Using Gemini as chat provider');
            this.provider = new GeminiProvider(config);
            this.activeModel = config.gemini.model;
            this.activeProvider = 'gemini';

            // Fallback to Ollama if available
            try {
                this.fallbackProvider = new OAIProvider({
                    model: config.ollama.model,
                    baseUrl: `http://${config.ollama.host}:${config.ollama.port}/v1/chat/completions`,
                });
                log.info('Fallback provider: Ollama', { model: config.ollama.model });
            } catch {
                log.debug('No fallback provider available');
            }
        } else if (config.chatProvider === 'chatgpt') {
            log.info('Using ChatGPT Enterprise as chat provider');
            const oauthToken = getOpenAIAccessTokenSync();
            this.provider = new OAIProvider({
                model: config.openai?.model || 'gpt-4o',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                apiKey: oauthToken || undefined,
            });
            this.activeModel = config.openai?.model || 'gpt-4o';
            this.activeProvider = 'chatgpt';
            if (!oauthToken) {
                log.warn('No ChatGPT OAuth token found — install Codex CLI and log in: npx @openai/codex');
            }
        } else {
            // ollama (default)
            log.info('Using Ollama (local) as chat provider');
            this.provider = new OAIProvider({
                model: config.ollama.model,
                baseUrl: `http://${config.ollama.host}:${config.ollama.port}/v1/chat/completions`,
                fallbackModel: config.ollama.fallbackModel,
            });
            this.activeModel = config.ollama.model;
            this.activeProvider = 'ollama';
        }

        // Initialize background provider — lightweight local model for non-user-facing tasks
        // (memory extraction, auto-title, session compaction, heartbeat)
        try {
            const bgModel = config.background?.model || config.ollama.model;
            this.backgroundProvider = new OAIProvider({
                model: bgModel,
                baseUrl: `http://${config.ollama.host}:${config.ollama.port}/v1/chat/completions`,
            });
            log.info('Background provider: Ollama', { model: bgModel });
        } catch {
            log.warn('Background provider unavailable — background tasks will use primary model');
        }

        // Initialize session persistence
        const dataDir = join(config.memory.dir, 'data');
        this.sessionStore = new SessionStore(dataDir);

        // Initialize DB-backed memory store (shares same DB file)
        const memStore = new MemoryStore(dataDir);
        memStore.migrateFromFiles(config.memory.dir);
        setMemoryStore(memStore);

        // Initialize RAG index for project file search
        if (config.gemini.apiKey) {
            try {
                this.ragIndex = new RAGIndex(dataDir, config.gemini.apiKey, process.cwd());
                // Auto-index in background on startup
                this.ragIndex.indexProject().then(stats => {
                    log.info('RAG index ready', stats);
                }).catch(err => {
                    log.warn('RAG indexing failed', { error: err.message });
                });
            } catch (err: any) {
                log.warn('RAG index init failed', { error: err.message });
            }
        }

        // Resume latest session or create a new one
        const latest = this.sessionStore.getLatestSession();
        if (latest && latest.messageCount > 0) {
            this.currentSessionId = latest.id;
            const allMessages = this.sessionStore.loadMessages(latest.id);
            // Cap to avoid exceeding model context window — memory files carry long-term knowledge
            const MAX_RESUME_MESSAGES = 10;
            if (allMessages.length > MAX_RESUME_MESSAGES) {
                this.conversationHistory = Agent.sanitizeHistory(allMessages.slice(-MAX_RESUME_MESSAGES));
                log.warn('Session truncated for context window', { total: allMessages.length, kept: this.conversationHistory.length });
            } else {
                this.conversationHistory = Agent.sanitizeHistory(allMessages);
            }
            log.info('Resumed session', { id: latest.id, title: latest.title, messages: this.conversationHistory.length });
        } else {
            this.currentSessionId = this.sessionStore.createSession();
            log.info('New session created', { id: this.currentSessionId });
        }

        // Load persisted cumulative stats
        const saved = this.sessionStore.loadStats();
        this.sessionStats.apiCalls = saved.apiCalls;
        this.sessionStats.toolCalls = saved.toolCalls;
        this.sessionStats.toolsUsed = saved.toolsUsed;

        // Register search_memory tool (needs SessionStore)
        registerTool({
            name: 'search_memory',
            description: 'Search past conversations for relevant information. Uses keyword matching across all past sessions.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Keywords or phrases to search for in past conversations' },
                },
                required: ['query'],
            },
            execute: async (args: Record<string, any>) => {
                // Search memory files (MEMORY.md, USER.md, etc.)
                const memResults = searchMemoryFiles(this.config.memory.dir, args.query);
                // Search past sessions
                const sessionResults = this.sessionStore.searchMessages(args.query, 5);

                const parts: string[] = [];
                if (memResults.length > 0) {
                    parts.push('**Memory Files:**\n' + memResults.map((r, i) => `[${i + 1}] ${r}`).join('\n'));
                }
                if (sessionResults.length > 0) {
                    parts.push('**Past Conversations:**\n' + sessionResults.map((r, i) =>
                        `[${i + 1}] Session: ${r.sessionTitle} | ${r.role}: ${r.content}`
                    ).join('\n\n'));
                }

                if (parts.length === 0) return 'No matching results found in memory or past conversations.';
                return parts.join('\n\n');
            },
        });

        // Register semantic_search tool (vector similarity via Gemini embeddings)
        registerTool({
            name: 'semantic_search',
            description: 'Search past conversations by meaning using AI embeddings. Better than keyword search for finding conceptually related discussions. Use when the user asks "what did we discuss about X?" or "find conversations related to Y".',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Natural language description of what to search for' },
                    limit: { type: 'integer', description: 'Maximum results to return (default: 5)' },
                },
                required: ['query'],
            },
            execute: async (args: Record<string, any>) => {
                const apiKey = this.config.gemini.apiKey;
                if (!apiKey) return 'Semantic search requires a Gemini API key for embeddings.';

                const results = await this.sessionStore.semanticSearch(args.query, apiKey, args.limit ?? 5);
                if (results.length === 0) return 'No semantically similar conversations found. Try keyword search with search_memory instead.';

                return '**Semantic Search Results:**\n' + results.map((r, i) =>
                    `[${i + 1}] (${(r.similarity * 100).toFixed(0)}% match) Session: ${r.sessionTitle} | ${r.role}: ${r.content}`
                ).join('\n\n');
            },
        });

        // Register entity_graph tool (knowledge graph of people, projects, concepts)
        registerTool({
            name: 'entity_graph',
            description: 'Manage a knowledge graph of entities (people, projects, concepts, tools, places) and their relationships. Use to track connections between things the user mentions.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['add_entity', 'add_relation', 'query', 'search', 'list'], description: 'Operation to perform' },
                    name: { type: 'string', description: 'Entity name (for add_entity, add_relation, query)' },
                    type: { type: 'string', description: 'Entity type: person, project, concept, tool, place (for add_entity, list)' },
                    description: { type: 'string', description: 'Entity description (for add_entity)' },
                    target: { type: 'string', description: 'Target entity name (for add_relation)' },
                    relation: { type: 'string', description: 'Relationship type, e.g. works_on, knows, uses (for add_relation)' },
                    query: { type: 'string', description: 'Search query (for search)' },
                },
                required: ['action'],
            },
            execute: async (args: Record<string, any>) => {
                const store = getMemoryStore();
                if (!store) return 'Error: Memory store not available';

                switch (args.action) {
                    case 'add_entity': {
                        if (!args.name || !args.type) return 'Error: name and type required';
                        const id = store.upsertEntity(args.name, args.type, args.description || '');
                        return `Entity "${args.name}" (${args.type}) saved with id ${id}`;
                    }
                    case 'add_relation': {
                        if (!args.name || !args.target || !args.relation) return 'Error: name, target, and relation required';
                        // Auto-create entities if they don't exist
                        if (!store.getEntity(args.name)) store.upsertEntity(args.name, 'concept');
                        if (!store.getEntity(args.target)) store.upsertEntity(args.target, 'concept');
                        const ok = store.addRelation(args.name, args.target, args.relation);
                        return ok ? `Relation added: ${args.name} —[${args.relation}]→ ${args.target}` : 'Error adding relation';
                    }
                    case 'query': {
                        if (!args.name) return 'Error: name required';
                        const entity = store.getEntity(args.name);
                        if (!entity) return `No entity found with name "${args.name}"`;
                        const rels = store.getRelations(args.name);
                        let result = `**${entity.name}** (${entity.type})\n${entity.description || 'No description'}`;
                        if (rels.length > 0) {
                            result += '\n\nRelationships:\n' + rels.map(r =>
                                r.direction === 'from' ? `  → ${r.relation} → ${r.entity}` : `  ← ${r.relation} ← ${r.entity}`
                            ).join('\n');
                        }
                        return result;
                    }
                    case 'search': {
                        if (!args.query) return 'Error: query required';
                        const results = store.searchEntities(args.query);
                        if (results.length === 0) return 'No entities found';
                        return results.map(e => `• **${e.name}** (${e.type}): ${e.description || 'no description'}`).join('\n');
                    }
                    case 'list': {
                        const entities = store.listEntities(args.type);
                        if (entities.length === 0) return args.type ? `No ${args.type} entities found` : 'No entities in graph';
                        return entities.map(e => `• **${e.name}** (${e.type}): ${e.description || 'no description'}`).join('\n');
                    }
                    default:
                        return `Unknown action "${args.action}". Use: add_entity, add_relation, query, search, list`;
                }
            },
        });

        // Register search_codebase tool (RAG over project files)
        registerTool({
            name: 'search_codebase',
            description: 'Search project files by meaning using AI embeddings. Finds relevant code, configs, and docs in the workspace. Use for understanding codebase structure, finding implementations, or locating related files.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Natural language description of what to find in the codebase' },
                    limit: { type: 'integer', description: 'Maximum results to return (default: 8)' },
                },
                required: ['query'],
            },
            execute: async (args: Record<string, any>) => {
                if (!this.ragIndex) return 'Codebase search is not available — GEMINI_API_KEY required for embeddings.';

                const results = await this.ragIndex.semanticSearch(args.query, args.limit ?? 8);
                if (results.length === 0) return 'No matching code found. Try different search terms or check if the project has been indexed.';

                return '**Codebase Search Results:**\n\n' + results.map((r, i) =>
                    `### [${i + 1}] ${r.path} (chunk ${r.chunkIndex})${r.similarity ? ` — ${(r.similarity * 100).toFixed(0)}% match` : ''}\n\`\`\`\n${r.content.slice(0, 500)}\n\`\`\``
                ).join('\n\n');
            },
        });

        // Register delegate_task tool (sub-agent orchestration)
        registerTool({
            name: 'delegate_task',
            description: 'Delegate a task to a sub-agent that runs independently. Good for research, analysis, or multi-step tasks that can run in parallel. The sub-agent has its own conversation and tool access.',
            parameters: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'Description of the task to delegate' },
                    tools: { type: 'string', description: 'Comma-separated list of tool names the sub-agent can use (default: all)' },
                    max_iterations: { type: 'integer', description: 'Max iterations for the sub-agent (default: 10)' },
                },
                required: ['task'],
            },
            execute: async (args: Record<string, any>) => {
                const { SubAgent } = await import('./sub-agent.js');
                const allowedTools: Set<string> = args.tools
                    ? new Set(args.tools.split(',').map((t: string) => t.trim()))
                    : new Set<string>();

                const subAgent = new SubAgent(
                    this.config,
                    this.provider,
                    this.backgroundProvider,
                    allowedTools,
                );

                // Inject active persona for personality-consistent sub-agents
                const activePersona = this.sessionStore.getActivePersona();
                const persona = activePersona ? {
                    name: activePersona.name,
                    soul: activePersona.soulContent,
                    identity: activePersona.identityContent,
                } : undefined;

                const result = await subAgent.execute({
                    task: args.task,
                    maxIterations: args.max_iterations ?? 10,
                    persona,
                });

                if (!result.success) {
                    return `Sub-agent failed: ${result.error}\n\nPartial result:\n${result.text}`;
                }

                return `**Sub-Agent Result** (${result.iterations} iterations, tools: ${result.toolsUsed.join(', ') || 'none'}):\n\n${result.text}`;
            },
        });

        // Register parallel_tasks tool — run multiple sub-agents concurrently
        registerTool({
            name: 'parallel_tasks',
            description: 'Run multiple tasks in parallel using independent sub-agents. Each task gets its own agent with its own conversation and tool access. All tasks execute concurrently and return combined results. Use when you need to do multiple independent things at once (e.g., research two topics simultaneously).',
            parameters: {
                type: 'object',
                properties: {
                    task_1: { type: 'string', description: 'First task description' },
                    task_2: { type: 'string', description: 'Second task description' },
                    task_3: { type: 'string', description: 'Third task description (optional)' },
                    task_4: { type: 'string', description: 'Fourth task description (optional)' },
                    task_5: { type: 'string', description: 'Fifth task description (optional)' },
                },
                required: ['task_1', 'task_2'],
            },
            execute: async (args: Record<string, any>) => {
                try {
                    const { SubAgent } = await import('./sub-agent.js');

                    // Collect all task_N parameters
                    const taskDescriptions: string[] = [];
                    for (let i = 1; i <= 5; i++) {
                        const desc = args[`task_${i}`];
                        if (desc && typeof desc === 'string' && desc.trim()) {
                            taskDescriptions.push(desc.trim());
                        }
                    }

                    if (taskDescriptions.length < 2) {
                        return 'Error: at least 2 tasks are required.';
                    }

                    const activePersona = this.sessionStore.getActivePersona();
                    const persona = activePersona ? {
                        name: activePersona.name,
                        soul: activePersona.soulContent,
                        identity: activePersona.identityContent,
                    } : undefined;

                    const subTasks = taskDescriptions.map(task => ({
                        task,
                        maxIterations: 10,
                        persona,
                    }));

                    log.info('Running parallel tasks', { count: subTasks.length });
                    const results = await SubAgent.runParallel(
                        subTasks,
                        this.config,
                        this.provider,
                        this.backgroundProvider,
                    );

                    // Format results
                    const parts = results.map((r, i) => {
                        const status = r.success ? '✅' : '❌';
                        return `### Task ${i + 1}: ${taskDescriptions[i]}\n${status} ${r.iterations} iterations, tools: ${r.toolsUsed.join(', ') || 'none'}\n\n${r.text}`;
                    });

                    return `**Parallel Results** (${results.length} tasks):\n\n${parts.join('\n\n---\n\n')}`;
                } catch (err: any) {
                    log.error('parallel_tasks failed', { error: err.message });
                    return `Parallel tasks failed: ${err.message}`;
                }
            },
        });

        // Register code tool (agentic coding mode)
        registerTool({
            name: 'code',
            description: 'Enter autonomous coding mode. Alice will read relevant files, plan changes, edit code, run build checks, and present a diff for review. Uses git stash for safe rollback. Use for multi-file changes, refactors, or feature implementation.',
            parameters: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'Description of the coding task' },
                    files: { type: 'string', description: 'Comma-separated list of specific files to focus on (optional)' },
                },
                required: ['task'],
            },
            execute: async (args: Record<string, any>) => {
                const { CodingAgent } = await import('./coding-agent.js');
                const codingAgent = new CodingAgent(
                    this.config,
                    this.provider,
                    this.backgroundProvider,
                );

                const files = args.files
                    ? args.files.split(',').map((f: string) => f.trim())
                    : undefined;

                const result = await codingAgent.execute({
                    task: args.task,
                    files,
                });

                const parts: string[] = [];
                parts.push(`**Coding Agent** (${result.iterations} iterations, ${result.filesChanged.length} files changed)`);
                parts.push('');
                parts.push(result.text);

                if (result.diff) {
                    parts.push('');
                    parts.push('**Changes:**');
                    parts.push('```diff');
                    parts.push(result.diff.slice(0, 5000));
                    parts.push('```');
                }

                if (!result.success) {
                    parts.push('');
                    parts.push(`⚠️ Task incomplete: ${result.error}`);
                    parts.push('To rollback: run \`git checkout . && git stash pop\`');
                }

                return parts.join('\n');
            },
        });

        // Register workspace_status tool
        registerTool({
            name: 'workspace_status',
            description: 'Get the current workspace status: RAG index stats, recently changed files, and system health. Use to understand the project state.',
            parameters: {
                type: 'object',
                properties: {},
            },
            execute: async () => {
                const parts: string[] = ['**Workspace Status**\n'];

                // RAG index stats
                if (this.ragIndex) {
                    const stats = this.ragIndex.getStats();
                    parts.push(`📚 **RAG Index:** ${stats.totalFiles} files, ${stats.totalChunks} chunks, ${stats.embeddedChunks} embedded`);
                    const pct = stats.totalChunks > 0 ? Math.round(stats.embeddedChunks / stats.totalChunks * 100) : 0;
                    parts.push(`   Embedding progress: ${pct}%`);
                } else {
                    parts.push('📚 RAG Index: not initialized');
                }

                // Recent git changes
                try {
                    const { execSync } = await import('child_process');
                    const recent = execSync('git diff --name-only HEAD~5 2>/dev/null || echo "(no git history)"', {
                        cwd: process.cwd(),
                        encoding: 'utf-8',
                        timeout: 5000,
                    }).trim();
                    if (recent && !recent.includes('no git history')) {
                        parts.push(`\n📝 **Recently changed files:**\n${recent.split('\n').map(f => `  - ${f}`).join('\n')}`);
                    }
                } catch { /* ignore */ }

                // Session stats
                parts.push(`\n📊 **Session:** ${this.sessionStats.apiCalls} API calls, ${this.sessionStats.toolCalls} tool calls`);
                parts.push(`🤖 **Model:** ${this.activeModel} (${this.activeProvider})`);
                parts.push(`📂 **Working dir:** ${process.cwd()}`);

                return parts.join('\n');
            },
        });

        // Register scheduler tools
        registerTool({
            name: 'set_reminder',
            description: 'Set a reminder. Use "in 5m", "in 2h" for one-shot, or cron expressions like "0 9 * * *" for recurring.',
            parameters: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'The reminder message' },
                    schedule: { type: 'string', description: 'When: "in 5m", "in 2h", or a cron expression' },
                },
                required: ['message', 'schedule'],
            },
            execute: async (args: Record<string, any>) => {
                try {
                    const { scheduler } = await import('../scheduler/task-scheduler.js');
                    const id = scheduler.addReminder(args.message, args.schedule);
                    return `✅ Reminder set (ID: ${id}): "${args.message}" — ${args.schedule}`;
                } catch (err: any) {
                    return `Error: ${err.message}`;
                }
            },
        });

        registerTool({
            name: 'cancel_reminder',
            description: 'Cancel an active reminder by its ID.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string', description: 'The reminder ID to cancel' } },
                required: ['id'],
            },
            execute: async (args: Record<string, any>) => {
                const { scheduler } = await import('../scheduler/task-scheduler.js');
                return scheduler.cancelReminder(args.id)
                    ? `Reminder ${args.id} cancelled.`
                    : `Reminder ${args.id} not found.`;
            },
        });

        registerTool({
            name: 'list_reminders',
            description: 'List all active reminders and file watchers.',
            parameters: { type: 'object', properties: {}, required: [] },
            execute: async () => {
                const { scheduler } = await import('../scheduler/task-scheduler.js');
                const reminders = scheduler.listReminders();
                const watchers = scheduler.listWatchers();
                const lines: string[] = [];
                if (reminders.length === 0 && watchers.length === 0) return 'No active reminders or watchers.';
                if (reminders.length > 0) {
                    lines.push('**Reminders:**');
                    for (const r of reminders) {
                        lines.push(`- [${r.id}] "${r.message}" (${r.schedule})${r.oneShot ? ' [one-shot]' : ' [recurring]'}`);
                    }
                }
                if (watchers.length > 0) {
                    lines.push('**File Watchers:**');
                    for (const w of watchers) {
                        lines.push(`- [${w.id}] ${w.path}`);
                    }
                }
                return lines.join('\n');
            },
        });

        registerTool({
            name: 'watch_file',
            description: 'Start watching a file or directory for changes. Alice will be notified when changes occur.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File or directory path to watch' },
                    description: { type: 'string', description: 'What to look for or report when changes happen' },
                },
                required: ['path'],
            },
            execute: async (args: Record<string, any>) => {
                const { scheduler } = await import('../scheduler/task-scheduler.js');
                const id = scheduler.watchFile(args.path, args.description || 'file changed');
                return `👁️ Now watching: ${args.path} (ID: ${id})`;
            },
        });

        // Skill installation tool
        registerTool({
            name: 'install_skill',
            description: 'Install a new skill for Alice from a git URL. The skill will be cloned, dependencies installed, and immediately available.',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: 'Git URL (e.g. https://github.com/user/alice-skill-name.git) or local path to a skill directory' },
                },
                required: ['source'],
            },
            execute: async (args: Record<string, any>) => {
                try {
                    const targetDir = this.config.skills.dirs[0]; // Install to project-local skills dir
                    const skillName = installSkill(args.source, targetDir);
                    this.refreshContext(); // Hot-reload to pick up new skill
                    return `✅ Skill "${skillName}" installed successfully to ${targetDir}/${skillName}. I've reloaded my context to include it.`;
                } catch (err: any) {
                    return `❌ Failed to install skill: ${err.message}`;
                }
            },
        });

        // Persona switching tool
        registerTool({
            name: 'switch_persona',
            description: 'Switch Alice\'s personality/persona. Available: "coding" (focused, technical), "research" (thorough, analytical), "casual" (friendly, conversational).',
            parameters: {
                type: 'object',
                properties: {
                    persona: { type: 'string', description: 'Persona name: "coding", "research", or "casual"' },
                },
                required: ['persona'],
            },
            execute: async (args: Record<string, any>) => {
                const persona = args.persona?.toLowerCase();
                const personas: Record<string, string> = {
                    coding: 'You are Alice in CODING mode. Be precise, technical, and action-oriented. Prefer showing code over explanation. Use tools eagerly. Skip pleasantries.',
                    research: 'You are Alice in RESEARCH mode. Be thorough and analytical. Cite sources when possible. Consider multiple perspectives. Think step-by-step.',
                    casual: 'You are Alice in CASUAL mode. Be warm, friendly, and conversational. Use emoji occasionally. Keep responses concise and approachable.',
                };
                if (!personas[persona]) {
                    return `Unknown persona "${persona}". Available: ${Object.keys(personas).join(', ')}`;
                }
                // Update the memory SOUL override
                const soulPath = join(this.config.memory.dir, 'SOUL.md');
                const { writeFileSync } = await import('fs');
                writeFileSync(soulPath, `# Soul\n\n${personas[persona]}\n`);
                this.refreshContext();
                return `✨ Switched to **${persona}** persona. My behavior has been updated.`;
            },
        });

        // Register canvas tool — push interactive HTML/JS inline into chat
        registerTool({
            name: 'canvas',
            description: 'Push interactive HTML/JS content to the user inline in chat. Use for dashboards, forms, visualizations, charts, interactive demos, calculators, games. The HTML renders in a sandboxed iframe within the chat.',
            parameters: {
                type: 'object',
                properties: {
                    html: { type: 'string', description: 'Complete HTML document to render (can include inline CSS and JS)' },
                    title: { type: 'string', description: 'Title shown above the canvas' },
                },
                required: ['html'],
            },
            execute: async (args: Record<string, any>) => {
                this.lastCanvasPayload = { html: args.html, title: args.title || 'Canvas' };
                // Persist canvas content to the session database
                this.pushMessage({
                    role: 'model',
                    parts: [{ text: `__canvas__${JSON.stringify({ html: args.html, title: args.title || 'Canvas' })}` }],
                });
                return 'Canvas content pushed to user. They can see it inline in the chat.';
            },
        });

        // Register location tool — request device location via browser Geolocation API
        registerTool({
            name: 'get_location',
            description: 'Get the user\'s current device location (latitude, longitude). Requires browser permission. Use for weather, local search, directions, nearby places, etc.',
            parameters: { type: 'object', properties: {}, required: [] },
            execute: async () => {
                return this.requestLocation();
            },
        });

        // Register knowledge graph tools — entity + relationship management
        registerTool({
            name: 'knowledge_graph',
            description: 'Query the knowledge graph to find entities (people, projects, concepts) and their relationships. Use to recall who/what is connected to whom/what.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['search', 'get', 'list', 'relations'], description: 'Action: search (fuzzy match), get (exact name), list (all entities), relations (get connections for an entity)' },
                    query: { type: 'string', description: 'Entity name or search query' },
                    type: { type: 'string', description: 'Filter by entity type (person, project, concept, place, company, etc.)' },
                },
                required: ['action'],
            },
            execute: async (args: Record<string, any>) => {
                const store = getMemoryStore();
                if (!store) return 'Error: Memory store not initialized.';

                switch (args.action) {
                    case 'search': {
                        const results = store.searchEntities(args.query || '');
                        if (results.length === 0) return 'No entities found matching query.';
                        return results.map(e => `**${e.name}** (${e.type}): ${e.description || 'No description'}`).join('\n');
                    }
                    case 'get': {
                        const entity = store.getEntity(args.query || '');
                        if (!entity) return `Entity "${args.query}" not found.`;
                        const rels = store.getRelations(entity.name);
                        const relStr = rels.length > 0
                            ? rels.map(r => `  ${r.direction === 'from' ? '→' : '←'} ${r.relation} → ${r.entity}`).join('\n')
                            : '  No relationships';
                        return `**${entity.name}** (${entity.type})\n${entity.description || 'No description'}\nCreated: ${entity.createdAt}\n\nRelationships:\n${relStr}`;
                    }
                    case 'list': {
                        const entities = store.listEntities(args.type);
                        if (entities.length === 0) return args.type ? `No entities of type "${args.type}" found.` : 'Knowledge graph is empty.';
                        return entities.map(e => `- **${e.name}** (${e.type}): ${e.description || ''}`).join('\n');
                    }
                    case 'relations': {
                        if (!args.query) return 'Error: query (entity name) is required for relations action.';
                        const rels = store.getRelations(args.query);
                        if (rels.length === 0) return `No relationships found for "${args.query}".`;
                        return rels.map(r => `${r.direction === 'from' ? '→' : '←'} **${r.relation}** → ${r.entity}`).join('\n');
                    }
                    default:
                        return 'Error: action must be one of: search, get, list, relations';
                }
            },
        });

        registerTool({
            name: 'add_knowledge',
            description: 'Add entities and relationships to the knowledge graph. Use to record people, projects, concepts, and how they connect. Entities are automatically merged by name.',
            parameters: {
                type: 'object',
                properties: {
                    entity_name: { type: 'string', description: 'Name of the entity to create/update' },
                    entity_type: { type: 'string', description: 'Type: person, project, concept, place, company, tool, event, etc.' },
                    description: { type: 'string', description: 'Brief description of the entity' },
                    relates_to: { type: 'string', description: 'Name of another entity this one relates to' },
                    relation: { type: 'string', description: 'The relationship type (e.g., "works_on", "knows", "uses", "part_of", "created_by")' },
                },
                required: ['entity_name', 'entity_type'],
            },
            execute: async (args: Record<string, any>) => {
                const store = getMemoryStore();
                if (!store) return 'Error: Memory store not initialized.';

                const entityId = store.upsertEntity(args.entity_name, args.entity_type, args.description || '');
                let msg = `Entity "${args.entity_name}" (${args.entity_type}) saved with ID ${entityId}.`;

                if (args.relates_to && args.relation) {
                    const added = store.addRelation(args.entity_name, args.relates_to, args.relation);
                    if (added) {
                        msg += ` Relationship added: ${args.entity_name} —${args.relation}→ ${args.relates_to}`;
                    } else {
                        msg += ` Note: Could not create relationship (target entity "${args.relates_to}" may not exist yet).`;
                    }
                }

                return msg;
            },
        });

        // Register notify_user tool — proactive push notifications
        registerTool({
            name: 'notify_user',
            description: 'Send a proactive push notification to the user via Google Chat and/or the web UI. Use this to alert the user about completed tasks, important events, or time-sensitive information when they may not be actively watching the chat.',
            parameters: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'The notification message to send' },
                    priority: { type: 'string', enum: ['info', 'warning', 'urgent'], description: 'Priority level (default: info)' },
                },
                required: ['message'],
            },
            execute: async (args: Record<string, any>) => {
                const priority = args.priority || 'info';
                const emoji = priority === 'urgent' ? '🚨' : priority === 'warning' ? '⚠️' : '💡';
                const fullMessage = `${emoji} **Alice Notification**\n\n${args.message}`;

                // Emit notification event — Gateway listens and routes to Google Chat + WebSocket
                toolEvents.emit('notification', {
                    type: 'proactive',
                    message: fullMessage,
                    priority,
                });

                log.info('Proactive notification sent', { priority, messageLength: args.message.length });
                return `Notification sent to user: ${args.message}`;
            },
        });
        // Register deep research tool — autonomous multi-step research via Interactions API
        registerTool({
            name: 'deep_research',
            description: 'Run a deep, multi-step research task using Gemini Deep Research agent. The agent autonomously browses the web, reads multiple sources, identifies knowledge gaps, and produces a comprehensive report with citations. Use for complex research questions that require synthesizing information from many sources. This is a long-running operation (1-5 minutes).',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The research question or topic to investigate thoroughly' },
                    additional_context: { type: 'string', description: 'Optional additional context or constraints for the research' },
                },
                required: ['query'],
            },
            execute: async (args: Record<string, any>) => {
                const apiKey = this.config.gemini?.apiKey || process.env.GEMINI_API_KEY;
                if (!apiKey) return 'Error: GEMINI_API_KEY is required for deep research.';

                const { GoogleGenAI } = await import('@google/genai');
                const client = new GoogleGenAI({ apiKey });

                const input = args.additional_context
                    ? `${args.query}\n\nAdditional context: ${args.additional_context}`
                    : args.query;

                log.info('Starting deep research', { query: args.query });
                const interaction = await (client as any).interactions.create({
                    input,
                    agent: 'deep-research-pro-preview-12-2025',
                    background: true,
                });

                const interactionId = interaction.id;
                log.info('Deep research started', { id: interactionId });

                // Poll for completion (max 10 minutes)
                const maxWaitMs = 10 * 60 * 1000;
                const pollIntervalMs = 10_000;
                const startTime = Date.now();

                while (Date.now() - startTime < maxWaitMs) {
                    await new Promise(r => setTimeout(r, pollIntervalMs));
                    const result = await (client as any).interactions.get(interactionId);

                    if (result.status === 'completed') {
                        const outputs = result.outputs || [];
                        const report = outputs.length > 0
                            ? outputs[outputs.length - 1].text || 'Research completed but no text output.'
                            : 'Research completed but no outputs returned.';
                        log.info('Deep research completed', { id: interactionId, reportChars: report.length });
                        return report;
                    }

                    if (result.status === 'failed') {
                        const errMsg = result.error || 'Unknown error';
                        log.error('Deep research failed', { id: interactionId, error: errMsg });
                        return `Deep research failed: ${errMsg}`;
                    }

                    // Still running — log progress
                    log.debug('Deep research polling', { id: interactionId, status: result.status, elapsed: Math.round((Date.now() - startTime) / 1000) });
                }

                return `Deep research timed out after 10 minutes. Interaction ID: ${interactionId} — you can check on it later.`;
            },
        });

        this.refreshContext();
    }

    // ── Canvas Methods ────────────────────────────────────────

    /**
     * Get the last canvas payload (called by Gateway after each agent iteration).
     */
    getLastCanvas(): { html: string; title: string } | null {
        return this.lastCanvasPayload;
    }

    /**
     * Clear the canvas payload after it's been sent to the client.
     */
    clearCanvas(): void {
        this.lastCanvasPayload = null;
    }

    // ── Location Methods ────────────────────────────────────────

    /**
     * Request location from the client. Returns a Promise that resolves
     * when the Gateway receives a location response from the WebSocket.
     * Times out after 15 seconds.
     */
    requestLocation(): Promise<string> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.locationResolver = null;
                resolve('Location unavailable — the request timed out. The user may have denied the location permission or the browser does not support geolocation.');
            }, 15000);

            this.locationResolver = { resolve, timer };
        });
    }

    /**
     * Called by the Gateway when a location response arrives from the client.
     */
    resolveLocation(lat: number | null, lng: number | null, accuracy: number | null, error?: string): void {
        if (!this.locationResolver) return;

        clearTimeout(this.locationResolver.timer);
        const { resolve } = this.locationResolver;
        this.locationResolver = null;

        if (error || lat === null || lng === null) {
            resolve(`Location unavailable: ${error || 'unknown error'}`);
        } else {
            resolve(`User's location: latitude ${lat}, longitude ${lng} (accuracy: ${Math.round(accuracy || 0)} meters)`);
        }
    }

    /**
     * Check if a location request is pending (used by Gateway to send WebSocket request).
     */
    hasLocationRequest(): boolean {
        return this.locationResolver !== null;
    }

    /**
     * Set up ChatGPT OAuth — fetch access token and inject into provider.
     */
    private async setupChatGPTAuth(): Promise<void> {
        try {
            const token = await getOpenAIAccessToken();
            if (token) {
                (this.provider as any).apiKey = token;
                log.info('ChatGPT OAuth token injected');
            } else {
                log.warn('No ChatGPT OAuth token found — install Codex CLI and log in: npx codex');
            }
        } catch (err: any) {
            log.error('ChatGPT OAuth setup failed', { error: err.message });
        }
    }

    /**
     * Reload memory + skills and rebuild the system prompt.
     */
    refreshContext(): void {
        // Invalidate the Gemini context cache — system prompt is about to change
        if (this.provider && 'invalidateCache' in this.provider) {
            (this.provider as any).invalidateCache();
        }

        const memory = loadMemory(this.config.memory.dir);
        const skills = loadSkills(this.config.skills.dirs);

        const memoryPrompt = buildSystemPrompt(memory);
        const skillPrompt = buildSkillPrompt(skills);

        // Get active persona (if non-default, overlay its soul/identity)
        const activePersona = this.sessionStore.getActivePersona();
        const personaName = activePersona?.name || 'Alice';
        let personaOverlay = '';
        if (activePersona && !activePersona.isDefault) {
            const parts: string[] = [];
            if (activePersona.soulContent) parts.push(`## Persona Personality\n${activePersona.soulContent}`);
            if (activePersona.identityContent) parts.push(`## Persona Identity\n${activePersona.identityContent}`);
            if (parts.length > 0) personaOverlay = '\n\n' + parts.join('\n\n');
        }

        const currentDate = new Date().toLocaleString('en-US', {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            dateStyle: 'full',
            timeStyle: 'short',
        });

        this.systemPrompt = [
            `You are ${personaName}, a personal AI assistant. Answer questions using the context below. Do NOT call tools for information already in your context.`,
            '',
            memoryPrompt,
            personaOverlay,
            '',
            `Current date/time: ${currentDate}`,
            `Working directory: ${process.cwd()}`,
            '',
            `You have core tools (bash, read_file, write_file, edit_file, web_search, search_memory, semantic_search, search_codebase, set_reminder, generate_image, canvas, get_location) plus these via bash: git status/diff/commit/log, clipboard read/write, web_fetch, read_pdf, list_directory, gemini (Gemini CLI).`,
            `IMPORTANT: When the user asks for charts, dashboards, visualizations, calculators, forms, or any interactive content, ALWAYS use the 'canvas' tool to push HTML directly inline in chat. Do NOT use write_file to create HTML files — use the canvas tool ONLY. If you absolutely must save a file, write it to ~/.alice/canvas/ (never to the working directory).`,
            `/no_think`,
        ].filter(Boolean).join('\n');

        log.info('System prompt built', { chars: this.systemPrompt.length, estimatedTokens: Math.round(this.systemPrompt.length / 4) });

        log.info('Context refreshed');
    }

    /**
     * Get the current system prompt (used by voice mode to inject context).
     */
    getSystemPrompt(): string {
        return this.systemPrompt;
    }

    /**
     * Save voice conversation transcripts to the session store.
     * Called by Gateway when a voice session ends.
     */
    saveVoiceTranscript(userText: string, assistantText: string): void {
        if (!userText.trim() && !assistantText.trim()) return;

        if (userText.trim()) {
            this.pushMessage({ role: 'user', parts: [{ text: `[Voice] ${userText.trim()}` }] });
        }
        if (assistantText.trim()) {
            this.pushMessage({ role: 'model', parts: [{ text: `[Voice] ${assistantText.trim()}` }] });
        }
        log.info('Voice transcript saved', {
            userChars: userText.length,
            assistantChars: assistantText.length,
        });
    }

    /**
     * Estimate token count for a set of messages (rough: ~4 chars per token).
     */
    private estimateTokens(messages: LLMMessage[]): number {
        let totalChars = 0;
        for (const msg of messages) {
            for (const part of msg.parts) {
                if ('text' in part && part.text) {
                    totalChars += part.text.length;
                } else if ('inlineData' in part) {
                    // Images are sent as binary — don't count base64 chars as text tokens.
                    // Vision models typically use ~500 tokens per image regardless of size.
                    totalChars += 2000; // ~500 tokens × 4 chars/token
                } else {
                    totalChars += JSON.stringify(part).length;
                }
            }
        }
        return Math.ceil(totalChars / 4);
    }

    /**
     * Proactive memory recall: search memory and past sessions for context
     * relevant to the current user message. Returns a string to append to
     * the system prompt, or empty string if nothing relevant found.
     *
     * Uses FTS5 (instant, no API call) for memory items + session messages.
     * Skips trivial messages (< 10 chars) and caps output at ~500 tokens.
     */
    private async proactiveRecall(userMessage: string): Promise<string> {
        // Skip trivial messages
        if (userMessage.length < 10) return '';

        const MAX_CHARS = 2000; // ~500 tokens
        const snippets: string[] = [];

        try {
            // 1. Search memory store (FTS on structured memory items)
            const memStore = getMemoryStore();
            if (memStore) {
                const memResults = memStore.searchItems(userMessage);
                for (const item of memResults.slice(0, 3)) {
                    snippets.push(`[Memory/${item.file}/${item.section}] ${item.content}`);
                }
            }

            // 2. Search session messages (FTS5 across all past sessions)
            const sessionResults = this.sessionStore.searchMessages(userMessage, 3);
            for (const r of sessionResults) {
                // Skip results from current session (already in context)
                if (r.sessionId === this.currentSessionId) continue;
                const truncated = r.content.length > 300 ? r.content.slice(0, 300) + '...' : r.content;
                snippets.push(`[Session: ${r.sessionTitle}] ${truncated}`);
            }

            if (snippets.length === 0) return '';

            // Build the recall block, capping at MAX_CHARS
            let recall = '\n\n---\n📌 **Recalled context** (from memory & past sessions — use if relevant):\n';
            for (const s of snippets) {
                if (recall.length + s.length > MAX_CHARS) break;
                recall += '- ' + s + '\n';
            }

            log.debug('Proactive recall', { snippets: snippets.length, chars: recall.length });
            return recall;
        } catch (err: any) {
            log.warn('Proactive recall failed', { error: err.message });
            return '';
        }
    }

    /**
     * Sanitize conversation history for Gemini API compatibility.
     * Gemini 3.x thinking models strictly require that:
     * - A functionResponse turn must immediately follow a functionCall turn
     * - No orphaned functionCall or functionResponse turns exist
     * - thought_signature parts are preserved in function call turns
     * Uses a two-pass approach to atomically keep/drop entire pairs.
     */
    static sanitizeHistory(messages: LLMMessage[]): LLMMessage[] {
        // Pass 1: identify matched functionCall/functionResponse pairs
        const keepIndices = new Set<number>();

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const hasFunctionCall = msg.parts.some((p: any) => 'functionCall' in p);

            if (hasFunctionCall) {
                // Look for a matching functionResponse as the NEXT message
                const next = messages[i + 1];
                if (next && next.parts.some((p: any) => 'functionResponse' in p)) {
                    // Keep both as a pair
                    keepIndices.add(i);
                    keepIndices.add(i + 1);
                } else {
                    log.debug('Dropping orphaned functionCall turn', { index: i });
                }
            }
        }

        // Pass 2: build result — keep matched pairs and non-function messages
        const result: LLMMessage[] = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const hasFunctionCall = msg.parts.some((p: any) => 'functionCall' in p);
            const hasFunctionResponse = msg.parts.some((p: any) => 'functionResponse' in p);

            if (hasFunctionCall || hasFunctionResponse) {
                // Only include if part of a matched pair
                if (keepIndices.has(i)) {
                    result.push(msg);
                } else if (hasFunctionResponse) {
                    log.debug('Dropping orphaned functionResponse turn', { index: i });
                }
            } else {
                result.push(msg);
            }
        }

        // Ensure the history starts with a user turn (Gemini API requirement)
        while (result.length > 0 && result[0].role !== 'user') {
            log.debug('Dropping leading non-user message');
            result.shift();
        }

        return result;
    }

    /**
     * Trim conversation context if approaching token budget.
     * Keeps the most recent messages and compresses the rest into a summary.
     */
    private async trimContextIfNeeded(): Promise<void> {
        const MAX_CONTEXT_TOKENS = 32000;
        const MIN_KEEP = 4;

        let tokenEstimate = this.estimateTokens(this.conversationHistory);
        if (tokenEstimate <= MAX_CONTEXT_TOKENS) return;

        log.warn('Context approaching token limit, trimming', {
            estimated: tokenEstimate,
            max: MAX_CONTEXT_TOKENS,
            messageCount: this.conversationHistory.length,
        });

        // Determine how many recent messages to keep
        let keepCount = Math.min(this.conversationHistory.length, 10);
        while (keepCount > MIN_KEEP) {
            const recent = this.conversationHistory.slice(-keepCount);
            const est = this.estimateTokens(recent);
            if (est <= MAX_CONTEXT_TOKENS) break;
            keepCount = Math.max(MIN_KEEP, keepCount - 2);
        }

        if (keepCount >= this.conversationHistory.length) {
            keepCount = MIN_KEEP;
        }

        // Adjust keepCount to avoid splitting a functionCall/functionResponse pair
        const trimIdx = this.conversationHistory.length - keepCount;
        if (trimIdx > 0 && trimIdx < this.conversationHistory.length) {
            const firstKept = this.conversationHistory[trimIdx];
            if (firstKept.parts.some((p: any) => 'functionResponse' in p)) {
                keepCount++;
            }
        }

        // Preserve the first user message (original query context)
        const firstUserIdx = this.conversationHistory.findIndex(m => m.role === 'user');
        const firstUserMsg = firstUserIdx >= 0 ? this.conversationHistory[firstUserIdx] : null;

        const oldMessages = this.conversationHistory.slice(0, -keepCount);
        const recentMessages = this.conversationHistory.slice(-keepCount);

        // Build context summary — use background model if available, else naive
        let summaryText: string;

        if (this.backgroundProvider) {
            try {
                const contextParts: string[] = [];
                for (const msg of oldMessages) {
                    const texts = msg.parts
                        .filter((p: any) => 'text' in p && p.text)
                        .map((p: any) => (p.text as string)?.slice(0, 200));
                    const toolParts = msg.parts
                        .filter((p: any) => 'functionCall' in p)
                        .map((p: any) => `[tool: ${(p as any).functionCall.name}]`);
                    const allParts = [...texts, ...toolParts].filter(Boolean);
                    if (allParts.length > 0) {
                        contextParts.push(`${msg.role}: ${allParts.join(' ')}`);
                    }
                }

                const summarizePrompt = [
                    {
                        role: 'user' as const, parts: [{
                            text:
                                `Summarize this conversation context in 2-3 sentences. Focus on: what the user asked for, what tools were used, and key results. Be concise.\n\n${contextParts.join('\n')}`
                        }]
                    }
                ];

                const summaryResp = await this.backgroundProvider.generateContent(
                    'You are a concise summarizer. Output only the summary, nothing else.',
                    summarizePrompt,
                    [],
                );

                if (summaryResp.text) {
                    summaryText = `[Context summary — ${oldMessages.length} earlier messages summarized by AI]\n${summaryResp.text}`;
                    log.debug('Background model generated context summary');
                } else {
                    throw new Error('Empty summary response');
                }
            } catch (err: any) {
                log.debug('Background summarization failed, using naive summary', { error: err.message });
                summaryText = Agent.buildNaiveSummary(oldMessages);
            }
        } else {
            summaryText = Agent.buildNaiveSummary(oldMessages);
        }

        // Reconstruct history: summary + first user message (if dropped) + recent
        const newHistory: LLMMessage[] = [
            { role: 'user', parts: [{ text: summaryText }] },
        ];

        // Re-insert the original user query if it was in the dropped messages
        if (firstUserMsg && firstUserIdx < this.conversationHistory.length - keepCount) {
            newHistory.push({ role: 'model', parts: [{ text: '[Acknowledged — continuing from context above]' }] });
            newHistory.push(firstUserMsg);
            newHistory.push({ role: 'model', parts: [{ text: '[Continuing with recent context]' }] });
        }

        newHistory.push(...recentMessages);

        this.conversationHistory = Agent.sanitizeHistory(newHistory);

        const newEstimate = this.estimateTokens(this.conversationHistory);
        log.info('Context trimmed', {
            before: tokenEstimate,
            after: newEstimate,
            kept: keepCount,
            messagesRemoved: oldMessages.length,
            usedAISummary: !!this.backgroundProvider,
        });
    }

    /**
     * Build a naive text summary of dropped messages (fallback when background model unavailable).
     */
    private static buildNaiveSummary(oldMessages: LLMMessage[]): string {
        const summaryParts: string[] = [];
        for (const msg of oldMessages.slice(-5)) {
            const textParts = msg.parts
                .filter((p: any) => 'text' in p && p.text)
                .map((p: any) => (p.text as string)?.slice(0, 80));
            if (textParts.length > 0) {
                summaryParts.push(`[${msg.role}]: ${textParts.join(' ')}`);
            }
        }
        return `[Context summary — ${oldMessages.length} earlier messages removed]\n${summaryParts.join('\n')}`;
    }

    /**
     * The core ReAct agentic loop.
     * Processes a user message through iterative tool calling
     * until a final text response is produced.
     */
    async processMessage(userMessage: string): Promise<AgentResponse> {
        log.info('Processing message', { length: userMessage.length });

        // Add user message to history
        this.pushMessage({
            role: 'user',
            parts: [{ text: userMessage }],
        });

        const functionDeclarations = toGeminiFunctionDeclarations();
        const toolsUsed: string[] = [];
        let iterations = 0;
        let rateLimitRetries = 0;
        const MAX_RATE_LIMIT_RETRIES = 5;
        let lastToolName = '';
        let sameToolCount = 0;

        // Proactive memory recall — augment system prompt with relevant past context
        const recalledContext = await this.proactiveRecall(userMessage);
        const originalPrompt = this.systemPrompt;
        if (recalledContext) this.systemPrompt += recalledContext;

        const startTime = Date.now();

        try {
            while (iterations < this.config.agent.maxIterations) {
                // Check timeout
                if (Date.now() - startTime > this.config.agent.timeoutMs) {
                    log.warn('Agent loop timed out', { iterations });
                    const timeoutMsg = 'I ran out of time processing your request. Here\'s what I accomplished so far.';
                    this.pushMessage({ role: 'model', parts: [{ text: timeoutMsg }] });
                    return { text: timeoutMsg, toolsUsed, iterations };
                }

                iterations++;
                log.debug(`Iteration ${iterations}/${this.config.agent.maxIterations}`);

                try {
                    // Trim context if approaching token budget
                    await this.trimContextIfNeeded();
                    // Sanitize before API call — ensures valid function call/response ordering
                    this.conversationHistory = Agent.sanitizeHistory(this.conversationHistory);

                    // Call the LLM
                    this.sessionStats.apiCalls++;
                    this.debouncePersistStats();
                    const response = await this.provider.generateContent(
                        this.systemPrompt,
                        this.conversationHistory,
                        functionDeclarations
                    );

                    // Case 1: Model wants to call function(s)
                    if (response.functionCalls && response.functionCalls.length > 0) {
                        // Use raw parts from the model response — these include thought_signature
                        // which Gemini 3 requires to be passed back in conversation history
                        this.pushMessage({ role: 'model', parts: response.rawParts });

                        // Execute tool calls in parallel for performance
                        for (const fc of response.functionCalls) {
                            log.info(`Tool call: ${fc.name}`, { args: Object.keys(fc.args) });
                            toolsUsed.push(fc.name);
                            this.sessionStats.toolCalls++;
                            this.sessionStats.toolsUsed[fc.name] = (this.sessionStats.toolsUsed[fc.name] || 0) + 1;
                        }
                        this.debouncePersistStats();

                        const results = await Promise.all(
                            response.functionCalls.map(fc => executeTool(fc.name, fc.args))
                        );

                        // Truncate tool results to save context window space
                        const truncatedResults = results.map(r =>
                            typeof r === 'string' && r.length > 2000
                                ? r.slice(0, 2000) + '\n\n... [truncated]'
                                : r
                        );

                        const responseParts: LLMPart[] = response.functionCalls.map((fc, i) => ({
                            functionResponse: {
                                name: fc.name,
                                response: { result: truncatedResults[i] },
                            },
                        }));

                        // Add tool results to history
                        this.pushMessage({ role: 'user', parts: responseParts });

                        // Loop detection: catch same-tool repeats AND multi-tool cycling
                        const currentToolName = response.functionCalls.map(fc => fc.name).join(',');
                        if (currentToolName === lastToolName) {
                            sameToolCount++;
                        } else {
                            lastToolName = currentToolName;
                            sameToolCount = 1;
                        }

                        // Same-tool loop detection
                        // IMPORTANT: Append hints to the existing functionResponse turn instead of
                        // creating a separate user message, to preserve the strict
                        // functionCall → functionResponse adjacency required by Gemini 3.x thinking models.
                        if (sameToolCount >= 3) {
                            log.warn('Same-tool loop detected', { tool: currentToolName, count: sameToolCount });
                            const lastMsg = this.conversationHistory[this.conversationHistory.length - 1];
                            lastMsg.parts.push({ text: `SYSTEM: You have called ${currentToolName} ${sameToolCount} times in a row. You already have the result — use it to answer the user\'s question directly. Do NOT call this tool again.` } as LLMPart);
                        }

                        // Force-break: if same tool called 5+ times, stop the loop entirely
                        if (sameToolCount >= 5) {
                            log.warn('Force-breaking tool loop', { tool: currentToolName, count: sameToolCount });
                            const breakMsg = `I called ${currentToolName} ${sameToolCount} times but couldn't complete the task. Here are the results I gathered so far.`;
                            this.pushMessage({ role: 'model', parts: [{ text: breakMsg }] });
                            return { text: breakMsg, toolsUsed, iterations };
                        }

                        // Multi-tool cycling: force-break if last 10 calls use ≤3 unique tools
                        if (toolsUsed.length >= 10) {
                            const recentTools = toolsUsed.slice(-10);
                            const uniqueRecent = new Set(recentTools).size;
                            if (uniqueRecent <= 3) {
                                log.warn('Force-breaking multi-tool cycle', { recentTools, uniqueRecent });
                                const cycleMsg = `I was cycling between ${[...new Set(recentTools)].join(', ')} without making progress. Here's what I found so far.`;
                                this.pushMessage({ role: 'model', parts: [{ text: cycleMsg }] });
                                return { text: cycleMsg, toolsUsed, iterations };
                            }
                        }

                        // Continue the loop — model needs to process tool results
                        continue;
                    }

                    // Case 2: Model produces a text response (we're done!)
                    if (response.text) {
                        this.pushMessage({
                            role: 'model',
                            parts: [{ text: response.text }],
                        });

                        // Log to daily memory
                        appendDailyLog(this.config.memory.dir, `Processed message (${iterations} iterations, ${toolsUsed.length} tool calls)`);

                        log.info('Message processed', { iterations, toolsUsed: toolsUsed.length });

                        // Auto-learn: extract facts from this exchange in the background
                        this.extractMemoryAsync(userMessage, response.text, toolsUsed);

                        return { text: response.text, toolsUsed, iterations };
                    }

                    // Case 3: Empty response (unusual — treat as error)
                    log.warn('Empty response from model', { iteration: iterations });
                    const emptyMsg = 'I received an empty response. Could you rephrase your request?';
                    this.pushMessage({ role: 'model', parts: [{ text: emptyMsg }] });
                    return { text: emptyMsg, toolsUsed, iterations };

                } catch (err: any) {
                    const errorMessage = err.message || String(err);
                    log.error('Error in agent loop', { error: errorMessage, iteration: iterations });

                    // Categorize error for smarter handling
                    const isRateLimit = errorMessage.includes('429') || errorMessage.includes('rate limit') || errorMessage.includes('Rate limited');
                    const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT');
                    const isModelError = errorMessage.includes('400') || errorMessage.includes('INVALID_ARGUMENT');

                    if (isRateLimit) {
                        rateLimitRetries++;
                        if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
                            const errMsg = `Rate limited after ${rateLimitRetries} retries. Please wait a moment and try again.`;
                            this.pushMessage({ role: 'model', parts: [{ text: errMsg }] });
                            return { text: errMsg, toolsUsed, iterations };
                        }
                        const waitMatch = errorMessage.match(/reset after (\d+)s/i);
                        const waitMs = waitMatch ? (parseInt(waitMatch[1], 10) + 1) * 1000 : 5000;
                        log.warn(`Rate limited (${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}), waiting ${waitMs}ms`);
                        await new Promise(r => setTimeout(r, waitMs));
                        iterations--; // Don't count rate limit retries as iterations
                        continue;
                    }

                    if (isTimeout) {
                        const timeoutMsg = `The request timed out. The model or service may be under load. Please try again.`;
                        this.pushMessage({ role: 'model', parts: [{ text: timeoutMsg }] });
                        return { text: timeoutMsg, toolsUsed, iterations };
                    }

                    if (isModelError) {
                        // 400/invalid errors can't self-correct — fail fast
                        const errMsg = `Request error: ${errorMessage.slice(0, 200)}. This is likely a configuration issue.`;
                        log.error('Non-recoverable model error, failing fast');
                        this.pushMessage({ role: 'model', parts: [{ text: errMsg }] });
                        return { text: errMsg, toolsUsed, iterations };
                    }

                    // For other errors, give the model one chance to self-correct
                    if (iterations >= this.config.agent.maxIterations) {
                        const errorMsg = `I encountered an error after ${iterations} attempts: ${errorMessage}. Please try again.`;
                        this.pushMessage({ role: 'model', parts: [{ text: errorMsg }] });
                        return { text: errorMsg, toolsUsed, iterations };
                    }

                    this.pushMessage({
                        role: 'model',
                        parts: [{ text: `An error occurred: ${errorMessage}. Adjusting approach and retrying.` }],
                    });
                }
            }

            // Max iterations reached
            log.warn('Max iterations reached');
            const maxMsg = `I reached the maximum number of iterations (${this.config.agent.maxIterations}). Here's what I have so far.`;
            this.pushMessage({ role: 'model', parts: [{ text: maxMsg }] });
            return { text: maxMsg, toolsUsed, iterations };
        } finally {
            // Restore original system prompt (remove proactive recall augmentation)
            this.systemPrompt = originalPrompt;
        }
    }

    /**
     * Streaming variant of processMessage.
     * Calls `onToken` for each text chunk as it arrives from the model.
     * Falls back to non-streaming if the provider doesn't support it.
     */
    async processMessageStream(
        userMessage: string,
        onToken: (token: string) => void,
        attachments: Array<{ name: string; type: string; data: string }> = [],
        onActivity?: (action: string, detail?: string) => void
    ): Promise<AgentResponse> {
        const emit = onActivity || (() => { });

        if (!this.provider.generateContentStream) {
            emit('fallback', 'Provider does not support streaming, using non-streaming mode');
            const result = await this.processMessage(userMessage);
            if (result.text) onToken(result.text);
            return result;
        }

        log.info('Processing message (streaming)', { length: userMessage.length, attachments: attachments.length });

        // Build user message parts: text + any file attachments
        const userParts: LLMPart[] = [{ text: userMessage }];
        for (const att of attachments) {
            (userParts as any[]).push({
                inlineData: {
                    mimeType: att.type,
                    data: att.data,
                },
            });
        }

        this.pushMessage({
            role: 'user',
            parts: userParts,
        });

        const functionDeclarations = toGeminiFunctionDeclarations();
        const toolsUsed: string[] = [];
        let iterations = 0;
        let rateLimitRetries = 0;
        const MAX_RATE_LIMIT_RETRIES = 5;
        let lastToolName = '';
        let sameToolCount = 0;

        // Proactive memory recall — augment system prompt with relevant past context
        const recalledContext = await this.proactiveRecall(userMessage);
        const originalPrompt = this.systemPrompt;
        if (recalledContext) this.systemPrompt += recalledContext;

        const startTime = Date.now();

        try {
            while (iterations < this.config.agent.maxIterations) {
                if (Date.now() - startTime > this.config.agent.timeoutMs) {
                    log.warn('Agent loop timed out', { iterations });
                    const timeoutMsg = 'I ran out of time processing your request.';
                    this.pushMessage({ role: 'model', parts: [{ text: timeoutMsg }] });
                    return { text: timeoutMsg, toolsUsed, iterations };
                }

                iterations++;
                emit('iteration', `Iteration ${iterations}/${this.config.agent.maxIterations}`);

                try {
                    // Trim context if approaching token budget
                    await this.trimContextIfNeeded();
                    // Sanitize before API call — ensures valid function call/response ordering
                    this.conversationHistory = Agent.sanitizeHistory(this.conversationHistory);

                    // Dynamic model routing: use vision model ONLY when the latest user message has images
                    // Only applies to Ollama — other providers handle vision natively
                    if (this.activeProvider === 'ollama') {
                        const lastUserMsg = [...this.conversationHistory].reverse().find(m => m.role === 'user');
                        const hasImages = lastUserMsg?.parts.some((p: any) => 'inlineData' in p) ?? false;
                        const oaiProvider = this.provider as any;
                        if (hasImages && oaiProvider.setModel && this.config.ollama?.visionModel) {
                            oaiProvider.setModel(this.config.ollama.visionModel);
                        } else if (!hasImages && oaiProvider.setModel) {
                            oaiProvider.setModel(this.config.ollama.model);
                        }
                    }

                    emit('llm_call', `Calling ${this.activeProvider} (${this.activeModel})`);
                    const llmStart = Date.now();
                    const response = await this.provider.generateContentStream!(
                        this.systemPrompt,
                        this.conversationHistory,
                        functionDeclarations,
                        onToken
                    );
                    this.sessionStats.apiCalls++;
                    this.debouncePersistStats();
                    emit('llm_done', `LLM responded in ${((Date.now() - llmStart) / 1000).toFixed(1)}s`);

                    // Tool calls
                    if (response.functionCalls && response.functionCalls.length > 0) {
                        this.pushMessage({ role: 'model', parts: response.rawParts });

                        for (const fc of response.functionCalls) {
                            log.info(`Tool call: ${fc.name}`, { args: Object.keys(fc.args) });
                            toolsUsed.push(fc.name);
                            this.sessionStats.toolCalls++;
                            this.sessionStats.toolsUsed[fc.name] = (this.sessionStats.toolsUsed[fc.name] || 0) + 1;
                            emit('tool_call', `${fc.name}(${Object.keys(fc.args).join(', ')})`);
                        }
                        this.debouncePersistStats();

                        const toolStart = Date.now();
                        const results = await Promise.all(
                            response.functionCalls.map(fc => executeTool(fc.name, fc.args))
                        );
                        const toolMs = Date.now() - toolStart;
                        emit('tool_done', `${response.functionCalls.length} tool(s) completed in ${(toolMs / 1000).toFixed(1)}s`);

                        // Truncate tool results to save context window space
                        const truncatedResults = results.map(r =>
                            typeof r === 'string' && r.length > 2000
                                ? r.slice(0, 2000) + '\n\n... [truncated]'
                                : r
                        );

                        const responseParts: LLMPart[] = response.functionCalls.map((fc, i) => ({
                            functionResponse: {
                                name: fc.name,
                                response: { result: truncatedResults[i] },
                            },
                        }));

                        this.pushMessage({ role: 'user', parts: responseParts });

                        // Loop detection: catch same-tool repeats AND multi-tool cycling
                        const currentToolName = response.functionCalls.map(fc => fc.name).join(',');
                        if (currentToolName === lastToolName) {
                            sameToolCount++;
                        } else {
                            lastToolName = currentToolName;
                            sameToolCount = 1;
                        }

                        // Append hints to the existing functionResponse turn (same fix as processMessage)
                        if (sameToolCount >= 3) {
                            log.warn('Same-tool loop detected', { tool: currentToolName, count: sameToolCount });
                            const lastMsg = this.conversationHistory[this.conversationHistory.length - 1];
                            lastMsg.parts.push({ text: `SYSTEM: You have called ${currentToolName} ${sameToolCount} times in a row. You already have the result — use it to answer the user\'s question directly. Do NOT call this tool again.` } as LLMPart);
                        }

                        // Force-break: if same tool called 5+ times, stop the loop entirely
                        if (sameToolCount >= 5) {
                            log.warn('Force-breaking tool loop', { tool: currentToolName, count: sameToolCount });
                            const breakMsg = `I called ${currentToolName} ${sameToolCount} times but couldn't complete the task. Here are the results I gathered so far.`;
                            this.pushMessage({ role: 'model', parts: [{ text: breakMsg }] });
                            return { text: breakMsg, toolsUsed, iterations };
                        }

                        // Multi-tool cycling: force-break if last 10 calls use ≤3 unique tools
                        if (toolsUsed.length >= 10) {
                            const recentTools = toolsUsed.slice(-10);
                            const uniqueRecent = new Set(recentTools).size;
                            if (uniqueRecent <= 3) {
                                log.warn('Force-breaking multi-tool cycle', { recentTools, uniqueRecent });
                                const cycleMsg = `I was cycling between ${[...new Set(recentTools)].join(', ')} without making progress. Here's what I found so far.`;
                                this.pushMessage({ role: 'model', parts: [{ text: cycleMsg }] });
                                return { text: cycleMsg, toolsUsed, iterations };
                            }
                        }

                        continue;
                    }

                    // Text response — streaming already sent tokens via onToken
                    if (response.text) {
                        this.pushMessage({
                            role: 'model',
                            parts: [{ text: response.text }],
                        });
                        appendDailyLog(this.config.memory.dir, `Processed message (${iterations} iterations, ${toolsUsed.length} tool calls)`);
                        log.info('Message processed (streaming)', { iterations, toolsUsed: toolsUsed.length });

                        // Auto-title: generate a short title after the first exchange
                        this.autoTitleIfNeeded(userMessage);

                        // Auto-learn: extract facts from this exchange in the background
                        this.extractMemoryAsync(userMessage, response.text, toolsUsed);

                        return { text: response.text, toolsUsed, iterations };
                    }

                    const emptyMsg = 'I received an empty response. Could you rephrase your request?';
                    this.pushMessage({ role: 'model', parts: [{ text: emptyMsg }] });
                    return { text: emptyMsg, toolsUsed, iterations };

                } catch (err: any) {
                    const errorMessage = err.message || String(err);
                    log.error('Error in agent loop', { error: errorMessage, iteration: iterations });

                    const isRateLimit = errorMessage.includes('429') || errorMessage.includes('rate limit') || errorMessage.includes('Rate limited');
                    const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT');
                    const isModelError = errorMessage.includes('400') || errorMessage.includes('INVALID_ARGUMENT');

                    // Model failover: switch to fallback provider on persistent rate limits
                    if (isRateLimit && this.fallbackProvider && !this.usingFallback) {
                        emit('failover', `Rate limited on ${this.activeProvider} — switching to fallback`);
                        log.warn('Rate limited — failing over to fallback provider', { from: this.activeProvider });
                        this.provider = this.fallbackProvider;
                        this.usingFallback = true;
                        this.activeProvider = this.activeProvider === 'gemini' ? 'ollama' : 'gemini';
                        this.activeModel = this.activeProvider === 'ollama' ? this.config.ollama.model : this.config.gemini.model;
                        emit('failover', `Now using ${this.activeProvider} (${this.activeModel})`);
                        onToken('\n\n> ⚡ *Switched to ' + this.activeProvider + ' (failover)*\n\n');
                        continue;
                    }

                    if (isRateLimit) {
                        rateLimitRetries++;
                        if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
                            emit('error', `Rate limited after ${rateLimitRetries} retries — giving up`);
                            const errMsg = `Rate limited after ${rateLimitRetries} retries. Please wait a moment and try again.`;
                            this.pushMessage({ role: 'model', parts: [{ text: errMsg }] });
                            return { text: errMsg, toolsUsed, iterations };
                        }
                        const waitMatch = errorMessage.match(/reset after (\d+)s/i);
                        const waitMs = waitMatch ? (parseInt(waitMatch[1], 10) + 1) * 1000 : 5000;
                        emit('rate_limit', `Rate limited (${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}), waiting ${(waitMs / 1000).toFixed(0)}s`);
                        log.warn(`Rate limited (${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}), waiting ${waitMs}ms`);
                        await new Promise(r => setTimeout(r, waitMs));
                        iterations--; // Don't count rate limit retries as iterations
                        continue;
                    }

                    if (isTimeout) {
                        emit('error', 'Request timed out');
                        const timeoutMsg = `The request timed out. Please try again.`;
                        this.pushMessage({ role: 'model', parts: [{ text: timeoutMsg }] });
                        return { text: timeoutMsg, toolsUsed, iterations };
                    }

                    if (isModelError) {
                        emit('error', `Model error: ${errorMessage.slice(0, 100)}`);
                        const errMsg = `Request error: ${errorMessage.slice(0, 200)}. This is likely a configuration issue.`;
                        log.error('Non-recoverable model error, failing fast');
                        this.pushMessage({ role: 'model', parts: [{ text: errMsg }] });
                        return { text: errMsg, toolsUsed, iterations };
                    }

                    if (iterations >= this.config.agent.maxIterations) {
                        const errorMsg = `I encountered an error after ${iterations} attempts: ${errorMessage}. Please try again.`;
                        this.pushMessage({ role: 'model', parts: [{ text: errorMsg }] });
                        return { text: errorMsg, toolsUsed, iterations };
                    }

                    this.pushMessage({
                        role: 'model',
                        parts: [{ text: `An error occurred: ${errorMessage}. Adjusting approach and retrying.` }],
                    });
                }
            }

            const maxMsg = `I reached the maximum number of iterations (${this.config.agent.maxIterations}).`;
            this.pushMessage({ role: 'model', parts: [{ text: maxMsg }] });
            return { text: maxMsg, toolsUsed, iterations };
        } finally {
            // Restore original system prompt (remove proactive recall augmentation)
            this.systemPrompt = originalPrompt;
        }
    }

    /**
     * Push a message to history and persist to session store.
     */
    private pushMessage(message: LLMMessage): void {
        this.conversationHistory.push(message);
        try {
            const messageId = this.sessionStore.saveMessage(this.currentSessionId, message);

            // Fire-and-forget: generate + store embedding asynchronously
            const textContent = message.parts
                .filter((p: any) => 'text' in p && p.text)
                .map((p: any) => p.text)
                .join(' ');
            if (textContent.trim() && this.config.gemini.apiKey) {
                this.sessionStore.embedMessage(messageId, this.currentSessionId, textContent, this.config.gemini.apiKey)
                    .catch(() => { /* non-blocking — failures are logged in embedMessage */ });
            }
        } catch (err: any) {
            log.warn('Failed to persist message', { error: err.message });
        }
    }

    /**
     * Clear conversation history and start a new session.
     */
    clearHistory(): void {
        this.conversationHistory = [];
        this.currentSessionId = this.sessionStore.createSession();
        log.info('Conversation history cleared, new session', { id: this.currentSessionId });
    }

    /**
     * Compact the conversation history by summarizing it into a condensed form.
     * Preserves key context while freeing up context window space.
     */
    async compactSession(): Promise<string> {
        if (this.conversationHistory.length < 4) {
            return 'Session is already compact (fewer than 4 messages).';
        }

        try {
            // Build a transcript of the conversation
            const transcript = this.conversationHistory.map(msg => {
                const text = msg.parts.map((p: any) => p.text || '[tool call]').join(' ');
                return `${msg.role === 'user' ? 'USER' : 'ASSISTANT'}: ${text.slice(0, 300)}`;
            }).join('\n');

            const bgProvider = this.backgroundProvider ?? this.provider;
            const result = await bgProvider.generateContent(
                'You are a conversation summarizer. Create a concise summary. /no_think',
                [{
                    role: 'user',
                    parts: [{
                        text: `Summarize this conversation into key points. Be concise but preserve important context, decisions, and facts.\n\n${transcript.slice(0, 3000)}\n\nOutput a brief summary (2-4 sentences).`
                    }]
                }],
                []
            );

            const summary = (result.text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            if (!summary || summary.length < 20) {
                return 'Failed to generate summary.';
            }

            const beforeCount = this.conversationHistory.length;
            // Replace history with a single context message
            this.conversationHistory = [{
                role: 'user',
                parts: [{ text: `[COMPACTED SESSION CONTEXT]\n${summary}` }]
            }, {
                role: 'model',
                parts: [{ text: 'Got it, I have the context from our previous conversation.' }]
            }];

            log.info('Session compacted', { before: beforeCount, after: 2, summaryLength: summary.length });
            return `✅ Session compacted: ${beforeCount} messages → 2. Summary:\n\n${summary}`;
        } catch (err: any) {
            log.error('Session compaction failed', { error: err.message });
            return `❌ Compaction failed: ${err.message}`;
        }
    }

    /**
     * Get session status info for /status command.
     */
    getStatus(): {
        sessionId: string;
        messageCount: number;
        model: string;
        fallbackModel?: string;
        systemPromptChars: number;
        estimatedTokens: number;
        lastUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    } {
        const provider = this.provider as any;
        return {
            sessionId: this.currentSessionId,
            messageCount: this.conversationHistory.length,
            model: this.config.ollama.model,
            fallbackModel: this.config.ollama.fallbackModel,
            systemPromptChars: this.systemPrompt.length,
            estimatedTokens: Math.round(this.systemPrompt.length / 4) +
                this.conversationHistory.reduce((sum, msg) => {
                    const text = msg.parts.map((p: any) => p.text || '').join('');
                    return sum + Math.round(text.length / 4);
                }, 0),
            lastUsage: provider.lastUsage || undefined,
        };
    }

    /**
     * Get usage stats for the current session.
     */
    getSessionStats(): {
        sessionDuration: number;
        apiCalls: number;
        toolCalls: number;
        toolsUsed: Record<string, number>;
        activeProvider: string;
        activeModel: string;
        usingFallback: boolean;
    } {
        return {
            sessionDuration: Date.now() - this.sessionStats.startTime,
            apiCalls: this.sessionStats.apiCalls,
            toolCalls: this.sessionStats.toolCalls,
            toolsUsed: { ...this.sessionStats.toolsUsed },
            activeProvider: this.activeProvider,
            activeModel: this.activeModel,
            usingFallback: this.usingFallback,
        };
    }

    /**
     * Debounced persistence of session stats to the DB.
     * Batches writes so rapid tool loops don't hammer SQLite.
     */
    private debouncePersistStats(): void {
        if (this.statsPersistTimer) clearTimeout(this.statsPersistTimer);
        this.statsPersistTimer = setTimeout(() => {
            try {
                this.sessionStore.saveStats({
                    apiCalls: this.sessionStats.apiCalls,
                    toolCalls: this.sessionStats.toolCalls,
                    toolsUsed: this.sessionStats.toolsUsed,
                });
            } catch (err: any) {
                log.warn('Failed to persist stats', { error: err.message });
            }
        }, 2000);
    }

    /**
     * Auto-generate a session title from the first user message.
     * Runs asynchronously in the background.
     */
    private autoTitleIfNeeded(userMessage: string): void {
        // Only title on the first exchange (user + model = 2 messages in history)
        const userMessages = this.conversationHistory.filter(m => m.role === 'user' && m.parts.some((p: any) => p.text));
        if (userMessages.length > 1) return; // Not the first exchange

        const sessionId = this.currentSessionId;
        // Generate title asynchronously — don't block the response
        (async () => {
            try {
                const titlePrompt = `Generate a very short title (3-6 words, no quotes, no punctuation at end) for a conversation that starts with this message: "${userMessage.slice(0, 200)}"`;
                const bgProvider = this.backgroundProvider ?? this.provider;
                const result = await bgProvider.generateContent(
                    'You are a title generator. Respond with only the title, nothing else. /no_think',
                    [{ role: 'user', parts: [{ text: titlePrompt }] }],
                    []
                );
                const title = (result.text || '').trim().replace(/^["']|["']$/g, '').slice(0, 60);
                if (title) {
                    this.sessionStore.updateTitle(sessionId, title);
                    log.info('Auto-titled session', { id: sessionId, title });
                }
            } catch (err: any) {
                log.warn('Auto-title failed', { error: err.message });
            }
        })();
    }

    /**
     * Extract facts from a conversation exchange and persist to MEMORY.md.
     * Runs asynchronously in the background — does not block the response.
     * Uses the lightweight background model (local Ollama) to avoid burning API credits.
     * Implements cooldown (60s) and batching (3 exchanges or 2-min timer) to reduce calls.
     */
    private extractMemoryAsync(userMessage: string, assistantResponse: string, toolsUsed: string[]): void {
        // Only extract when the conversation was substantial
        const isSubstantial = toolsUsed.length > 0 || userMessage.length > 100;
        if (!isSubstantial) return;

        // Cooldown: skip if less than 60 seconds since last extraction
        const EXTRACTION_COOLDOWN_MS = 60_000;
        const now = Date.now();
        if (now - this.lastExtractionTime < EXTRACTION_COOLDOWN_MS) {
            log.debug('Memory extraction skipped (cooldown)', {
                sinceLastMs: now - this.lastExtractionTime,
            });
            // Buffer for batch extraction
            this.pendingExtractions.push({ userMessage, assistantResponse, toolsUsed });
            this.scheduleExtractionFlush();
            return;
        }

        // Buffer this exchange
        this.pendingExtractions.push({ userMessage, assistantResponse, toolsUsed });

        // Flush if we've accumulated enough, or schedule a timer
        const BATCH_SIZE = 3;
        if (this.pendingExtractions.length >= BATCH_SIZE) {
            this.flushExtractions();
        } else {
            this.scheduleExtractionFlush();
        }
    }

    /**
     * Schedule a timer to flush pending extractions after 2 minutes.
     */
    private scheduleExtractionFlush(): void {
        if (this.extractionTimer) return; // Already scheduled
        this.extractionTimer = setTimeout(() => {
            this.extractionTimer = null;
            if (this.pendingExtractions.length > 0) {
                this.flushExtractions();
            }
        }, 2 * 60_000); // 2 minutes
    }

    /**
     * Flush all pending extractions in a single batch LLM call.
     * Uses the background provider (local Ollama) to avoid burning API credits.
     */
    private flushExtractions(): void {
        const exchanges = this.pendingExtractions.splice(0);
        if (exchanges.length === 0) return;

        if (this.extractionTimer) {
            clearTimeout(this.extractionTimer);
            this.extractionTimer = null;
        }

        this.lastExtractionTime = Date.now();

        const memoryDir = this.config.memory.dir;
        const provider = this.backgroundProvider ?? this.provider;

        (async () => {
            try {
                // Build a combined transcript for batch extraction
                const transcript = exchanges.map((ex, i) =>
                    `--- Exchange ${i + 1} ---\nUSER: ${ex.userMessage.slice(0, 300)}\nASSISTANT: ${ex.assistantResponse.slice(0, 300)}`
                ).join('\n\n');

                const extractPrompt = `Analyze these conversation exchanges and extract facts to store in memory files.

Route each fact to the correct file:
- "user" → personal info, preferences, habits, name, birthday, work style
- "memory" → project details, tech stacks, architecture decisions, workflows

For each fact, specify an action:
- "add" → new information
- "update" → corrects/replaces existing info (include "match" to find the old text)
- "remove" → info is no longer true (include "match" to find text to delete)

For "user" file facts, specify a section: "About Anthony", "Preferences", or "Active Projects".

${transcript}

Respond with ONLY valid JSON (no markdown, no code fences). If nothing to extract, respond: {"updates":[]}
Format: {"updates":[{"file":"user","action":"add","section":"About Anthony","content":"fact here"},{"file":"memory","action":"add","content":"fact here"}]}`;

                const result = await provider.generateContent(
                    'You are a JSON fact extraction system. Output only valid JSON. Be concise. /no_think',
                    [{ role: 'user', parts: [{ text: extractPrompt }] }],
                    []
                );

                const text = (result.text || '').trim();
                if (!text || text === 'NONE' || text.length < 10) return;

                // Parse JSON response — try to extract JSON if wrapped in markdown
                let jsonStr = text;
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) jsonStr = jsonMatch[0];

                let parsed: { updates?: MemoryUpdate[] };
                try {
                    parsed = JSON.parse(jsonStr);
                } catch {
                    // Fallback: treat as bullet list for backward compat
                    const facts = text.split('\n')
                        .map(line => line.trim())
                        .filter(line => line.startsWith('-') || line.startsWith('•') || line.startsWith('*'))
                        .map(line => line.replace(/^[-•*]\s*/, '').trim())
                        .filter(fact => fact.length >= 10);
                    if (facts.length > 0) {
                        const appended = await appendFacts(memoryDir, facts);
                        if (appended > 0) log.info(`Auto-learned ${appended} facts (fallback)`);
                    }
                    return;
                }

                if (!parsed.updates || parsed.updates.length === 0) return;

                // Validate and sanitize updates
                const validUpdates = parsed.updates.filter(u =>
                    u && u.file && u.action && u.content &&
                    ['user', 'memory'].includes(u.file) &&
                    ['add', 'update', 'remove'].includes(u.action)
                );

                if (validUpdates.length === 0) return;

                const changed = await updateMemory(memoryDir, validUpdates);
                if (changed > 0) {
                    log.info(`Smart memory update (batch of ${exchanges.length})`, {
                        changes: changed,
                        updates: validUpdates.map(u => `${u.action}:${u.file}`),
                    });
                    // Refresh context so next response uses updated memory
                    this.refreshContext();
                }
            } catch (err: any) {
                log.debug('Memory extraction failed (non-critical)', { error: err.message });
            }
        })();
    }

    /**
     * Get the current session ID.
     */
    getSessionId(): string {
        return this.currentSessionId;
    }

    /**
     * Get the config (for API endpoints that need config values).
     */
    getConfig(): typeof this.config {
        return this.config;
    }

    /**
     * Get the session store (for search API endpoints).
     */
    getSessionStore() {
        return this.sessionStore;
    }

    /**
     * Get the RAG index (for file watcher to trigger re-indexing).
     */
    getRagIndex() {
        return this.ragIndex;
    }

    /**
     * Get the LLM provider (for memory consolidation).
     */
    getProvider(): any {
        return this.provider;
    }

    /**
     * Get the background provider (for heartbeat, consolidation — uses local Ollama).
     * Falls back to the primary provider if background is unavailable.
     */
    getBackgroundProvider(): any {
        return this.backgroundProvider ?? this.provider;
    }

    /**
     * Process a message using the background provider with full tool support.
     * Runs a ReAct tool loop with isolated history (doesn't pollute the user's conversation).
     * Used for heartbeat tasks, scheduled checks, and other background operations.
     */
    async processBackgroundMessage(message: string, opts?: { useMainProvider?: boolean; model?: string }): Promise<AgentResponse> {
        let bgProvider: ChatProvider;
        if (opts?.model) {
            // Create an ad-hoc provider for the specified model
            const { OAIProvider } = await import('./providers/oai-provider.js');
            bgProvider = new OAIProvider({
                model: opts.model,
                baseUrl: `http://localhost:11434/v1/chat/completions`,
            });
        } else if (opts?.useMainProvider) {
            bgProvider = this.provider;
        } else {
            bgProvider = this.backgroundProvider ?? this.provider;
        }
        const functionDeclarations = toGeminiFunctionDeclarations();
        const maxIterations = 10;
        const toolsUsed: string[] = [];

        // Isolated message history — not persisted, not shared with main conversation
        const messages: LLMMessage[] = [
            { role: 'user', parts: [{ text: message }] },
        ];

        const systemPrompt = [
            'You are a background task agent with full access to MCP tools (Gmail, Calendar, Weather, etc).',
            'You MUST use the available tools to gather real data. Do NOT guess or make up information.',
            'Execute each step of the task using tool calls, then compile the results.',
        ].join('\n');

        log.debug('Background message starting', { toolCount: functionDeclarations.length, message: message.slice(0, 100) });

        for (let i = 0; i < maxIterations; i++) {
            try {
                const response = await bgProvider.generateContent(
                    systemPrompt,
                    messages,
                    functionDeclarations
                );

                log.debug('Background iteration', {
                    iteration: i + 1,
                    hasText: !!response.text,
                    textLength: response.text?.length || 0,
                    functionCalls: response.functionCalls?.length || 0,
                    functionNames: response.functionCalls?.map(fc => fc.name) || [],
                });

                // Tool calls — execute and loop
                if (response.functionCalls?.length) {
                    // Record tool call in history — use rawParts to preserve
                    // thought_signature which Gemini 3 requires in follow-up turns
                    messages.push({
                        role: 'model',
                        parts: response.rawParts || response.functionCalls.map(fc => ({
                            functionCall: { name: fc.name, args: fc.args },
                        })),
                    });

                    const results = await Promise.all(
                        response.functionCalls.map(fc => {
                            toolsUsed.push(fc.name);
                            return executeTool(fc.name, fc.args);
                        })
                    );

                    // Truncate results and add to history
                    const responseParts: LLMPart[] = response.functionCalls.map((fc, i) => ({
                        functionResponse: {
                            name: fc.name,
                            response: {
                                result: typeof results[i] === 'string' && results[i].length > 2000
                                    ? results[i].slice(0, 2000) + '\n\n... [truncated]'
                                    : results[i],
                            },
                        },
                    }));
                    messages.push({ role: 'user', parts: responseParts });
                    continue;
                }

                // Text response — done
                if (response.text) {
                    const cleanText = response.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                    log.info('Background message processed', { iterations: i + 1, toolsUsed: toolsUsed.length, resultLength: cleanText.length });
                    return { text: cleanText, toolsUsed, iterations: i + 1 };
                }

                // Empty response
                log.warn('Background message returned empty response', { iteration: i + 1 });
                return { text: '', toolsUsed, iterations: i + 1 };
            } catch (err: any) {
                log.error('Background message error', { error: err.message, iteration: i + 1 });
                return { text: `Background task error: ${err.message}`, toolsUsed, iterations: i + 1 };
            }
        }

        return { text: 'Background task reached max iterations.', toolsUsed, iterations: maxIterations };
    }

    /**
     * Get the current conversation history.
     */
    getHistory(): LLMMessage[] {
        return [...this.conversationHistory];
    }

    /**
     * Switch to an existing session by ID.
     */
    switchSession(sessionId: string): void {
        const messages = this.sessionStore.loadMessages(sessionId);
        this.conversationHistory = messages;
        this.currentSessionId = sessionId;
        log.info('Switched to session', { id: sessionId, messages: messages.length });
    }

    /**
     * List all sessions (most recent first).
     */
    listSessions(limit = 50): any[] {
        return this.sessionStore.listSessions(limit);
    }

    /**
     * Delete a session.
     */
    deleteSession(sessionId: string): void {
        this.sessionStore.deleteSession(sessionId);
        // If we deleted the current session, start a new one
        if (sessionId === this.currentSessionId) {
            this.clearHistory();
        }
    }

    /**
     * Get messages for a specific session (for API).
     */
    getSessionMessages(sessionId: string): LLMMessage[] {
        return this.sessionStore.loadMessages(sessionId);
    }

    /**
     * List available models from all configured providers.
     */
    async listAvailableModels(): Promise<Array<{ id: string; name: string; provider: string; toolCapable: boolean; capabilities: string[] }>> {
        const models: Array<{ id: string; name: string; provider: string; toolCapable: boolean; capabilities: string[] }> = [];

        // ── Ollama models ──
        try {
            const resp = await fetch(`http://${this.config.ollama.host}:${this.config.ollama.port}/api/tags`, {
                signal: AbortSignal.timeout(3000),
            });
            if (resp.ok) {
                const data: any = await resp.json();
                for (const m of data.models || []) {
                    const isVision = m.name.includes('-vl') || m.name.includes('vision');
                    models.push({
                        id: m.name,
                        name: `${m.name} (local)`,
                        provider: 'ollama',
                        toolCapable: true,
                        capabilities: isVision ? ['vision'] : [],
                    });
                }
            }
        } catch {
            log.warn('Could not fetch Ollama models');
        }

        // ── Gemini models ──
        const hasGemini = this.config.gemini.apiKey || hasCliCredentials();
        if (hasGemini) {
            const authLabel = hasCliCredentials() && this.config.gemini.auth !== 'apikey' ? 'Ultra' : 'API';
            models.push(
                {
                    id: 'gemini-3-flash-preview',
                    name: `Gemini 3 Flash (${authLabel})`,
                    provider: 'gemini',
                    toolCapable: true,
                    capabilities: ['reasoning'],
                },
                {
                    id: 'gemini-3-pro-preview',
                    name: `Gemini 3 Pro (${authLabel})`,
                    provider: 'gemini',
                    toolCapable: true,
                    capabilities: ['reasoning'],
                },
                {
                    id: 'gemini-3.1-pro-preview',
                    name: `Gemini 3.1 Pro (${authLabel})`,
                    provider: 'gemini',
                    toolCapable: true,
                    capabilities: ['reasoning'],
                },
                {
                    id: 'gemini-2.5-flash',
                    name: `Gemini 2.5 Flash (${authLabel})`,
                    provider: 'gemini',
                    toolCapable: true,
                    capabilities: ['reasoning'],
                },
                {
                    id: 'gemini-2.5-pro',
                    name: `Gemini 2.5 Pro (${authLabel})`,
                    provider: 'gemini',
                    toolCapable: true,
                    capabilities: ['reasoning'],
                },
            );
        }

        // ── OpenRouter free models ──
        if (this.config.openRouter.apiKey) {
            try {
                const resp = await fetch('https://openrouter.ai/api/v1/models', {
                    signal: AbortSignal.timeout(8000),
                });
                if (resp.ok) {
                    const data: any = await resp.json();
                    for (const m of data.data || []) {
                        const pricing = m.pricing || {};
                        const isFree = parseFloat(pricing.prompt || '1') === 0 && parseFloat(pricing.completion || '1') === 0;
                        const hasTools = m.supported_parameters?.includes('tools');
                        if (!isFree || !hasTools) continue;
                        const caps: string[] = [];
                        const modality = m.architecture?.modality || '';
                        if (modality.includes('image') || m.id?.includes('-vl')) caps.push('vision');
                        if (m.supported_parameters?.includes('reasoning') || m.id?.includes('thinking')) caps.push('reasoning');
                        models.push({
                            id: m.id,
                            name: m.name || m.id,
                            provider: 'openrouter',
                            toolCapable: true,
                            capabilities: caps,
                        });
                    }
                }
            } catch {
                log.warn('Could not fetch OpenRouter models');
            }
        }

        // ── ChatGPT / OpenAI models (via Codex CLI OAuth) ──
        if (hasCodexCredentials()) {
            models.push(
                {
                    id: 'gpt-4o',
                    name: 'GPT-4o (Enterprise)',
                    provider: 'chatgpt',
                    toolCapable: true,
                    capabilities: ['vision', 'reasoning'],
                },
                {
                    id: 'gpt-4o-mini',
                    name: 'GPT-4o Mini (Enterprise)',
                    provider: 'chatgpt',
                    toolCapable: true,
                    capabilities: [],
                },
                {
                    id: 'o3-mini',
                    name: 'o3-mini (Enterprise)',
                    provider: 'chatgpt',
                    toolCapable: true,
                    capabilities: ['reasoning'],
                },
                {
                    id: 'o4-mini',
                    name: 'o4-mini (Enterprise)',
                    provider: 'chatgpt',
                    toolCapable: true,
                    capabilities: ['reasoning'],
                },
            );
        }

        return models;
    }

    /**
     * Switch to a different model/provider at runtime.
     */
    switchModel(provider: string, model: string): void {
        if (provider === 'gemini') {
            const geminiConfig = { ...this.config, gemini: { ...this.config.gemini, model } };
            this.provider = new GeminiProvider(geminiConfig);
            this.activeModel = model;
            this.activeProvider = 'gemini';
        } else if (provider === 'openrouter') {
            this.provider = new OAIProvider({
                model,
                baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
                apiKey: this.config.openRouter.apiKey,
            });
            this.activeModel = model;
            this.activeProvider = 'openrouter';
        } else if (provider === 'chatgpt') {
            const token = getOpenAIAccessTokenSync();
            this.provider = new OAIProvider({
                model,
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                apiKey: token || undefined,
            });
            this.activeModel = model;
            this.activeProvider = 'chatgpt';
        } else {
            this.provider = new OAIProvider({
                model,
                baseUrl: `http://${this.config.ollama.host}:${this.config.ollama.port}/v1/chat/completions`,
                fallbackModel: this.config.ollama.fallbackModel,
            });
            this.activeModel = model;
            this.activeProvider = 'ollama';
        }
        log.info('Model switched', { provider, model });
        this.refreshContext();
    }
}
