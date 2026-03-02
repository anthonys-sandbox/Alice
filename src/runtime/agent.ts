import { GeminiProvider, type LLMMessage, type LLMPart, type LLMResponse, type FunctionDeclaration } from './providers/gemini.js';
import { OAIProvider } from './providers/oai-provider.js';
import { hasCliCredentials } from './providers/gemini-cli-auth.js';
import { getOpenAIAccessToken, getOpenAIAccessTokenSync, hasCodexCredentials } from './providers/openai-oauth.js';
import { executeTool, toGeminiFunctionDeclarations, registerTool } from './tools/registry.js';
import { loadMemory, buildSystemPrompt, appendDailyLog, appendFacts, updateMemory, searchMemoryFiles, type MemoryUpdate } from '../memory/index.js';
import { loadSkills, buildSkillPrompt, installSkill } from '../skills/loader.js';
import { SessionStore } from '../memory/sessions.js';
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
    private config: AliceConfig;
    private conversationHistory: LLMMessage[] = [];
    private systemPrompt: string = '';
    private sessionStore: SessionStore;
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

        // Initialize session persistence
        const dataDir = join(config.memory.dir, 'data');
        this.sessionStore = new SessionStore(dataDir);

        // Resume latest session or create a new one
        const latest = this.sessionStore.getLatestSession();
        if (latest && latest.messageCount > 0) {
            this.currentSessionId = latest.id;
            const allMessages = this.sessionStore.loadMessages(latest.id);
            // Cap to avoid exceeding model context window — memory files carry long-term knowledge
            const MAX_RESUME_MESSAGES = 10;
            if (allMessages.length > MAX_RESUME_MESSAGES) {
                this.conversationHistory = allMessages.slice(-MAX_RESUME_MESSAGES);
                log.warn('Session truncated for context window', { total: allMessages.length, kept: MAX_RESUME_MESSAGES });
            } else {
                this.conversationHistory = allMessages;
            }
            log.info('Resumed session', { id: latest.id, title: latest.title, messages: this.conversationHistory.length });
        } else {
            this.currentSessionId = this.sessionStore.createSession();
            log.info('New session created', { id: this.currentSessionId });
        }

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
        const memory = loadMemory(this.config.memory.dir);
        const skills = loadSkills(this.config.skills.dirs);

        const memoryPrompt = buildSystemPrompt(memory);
        const skillPrompt = buildSkillPrompt(skills);

        const currentDate = new Date().toLocaleString('en-US', {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            dateStyle: 'full',
            timeStyle: 'short',
        });

        this.systemPrompt = [
            `You are Alice, a personal AI assistant. Answer questions using the context below. Do NOT call tools for information already in your context.`,
            '',
            memoryPrompt,
            '',
            `Current date/time: ${currentDate}`,
            `Working directory: ${process.cwd()}`,
            '',
            `You have core tools (bash, read_file, write_file, edit_file, web_search, search_memory, set_reminder, generate_image) plus these via bash: git status/diff/commit/log, clipboard read/write, web_fetch, read_pdf, list_directory, gemini (Gemini CLI).`,
            `/no_think`,
        ].filter(Boolean).join('\n');

        log.info('System prompt built', { chars: this.systemPrompt.length, estimatedTokens: Math.round(this.systemPrompt.length / 4) });

        log.info('Context refreshed');
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
     * Trim conversation context if approaching token budget.
     * Keeps the most recent messages and compresses the rest into a summary.
     */
    private trimContextIfNeeded(): void {
        // Token budget: leave room for system prompt + response + tools
        const MAX_CONTEXT_TOKENS = 24000;
        const MIN_KEEP = 4; // Always keep at least the last few messages

        let tokenEstimate = this.estimateTokens(this.conversationHistory);
        if (tokenEstimate <= MAX_CONTEXT_TOKENS) return;

        log.warn('Context approaching token limit, trimming', {
            estimated: tokenEstimate,
            max: MAX_CONTEXT_TOKENS,
            messageCount: this.conversationHistory.length,
        });

        // Aggressively trim: drop oldest messages until under budget
        // Keep dropping until we're under the token limit
        let keepCount = Math.min(this.conversationHistory.length, 10);
        while (keepCount > MIN_KEEP) {
            const recent = this.conversationHistory.slice(-keepCount);
            const est = this.estimateTokens(recent);
            if (est <= MAX_CONTEXT_TOKENS) break;
            keepCount = Math.max(MIN_KEEP, keepCount - 2);
        }

        if (keepCount >= this.conversationHistory.length) {
            // Can't trim further — just keep MIN_KEEP
            keepCount = MIN_KEEP;
        }

        const oldMessages = this.conversationHistory.slice(0, -keepCount);
        const recentMessages = this.conversationHistory.slice(-keepCount);

        // Build a brief summary
        const summaryParts: string[] = [];
        for (const msg of oldMessages.slice(-5)) { // Only summarize last 5 dropped
            const textParts = msg.parts
                .filter((p: any) => 'text' in p && p.text)
                .map((p: any) => (p.text as string)?.slice(0, 80));
            if (textParts.length > 0) {
                summaryParts.push(`[${msg.role}]: ${textParts.join(' ')}`);
            }
        }

        const summaryText = `[Context summary — ${oldMessages.length} earlier messages removed]\n${summaryParts.join('\n')}`;

        this.conversationHistory = [
            { role: 'user', parts: [{ text: summaryText }] },
            ...recentMessages,
        ];

        const newEstimate = this.estimateTokens(this.conversationHistory);
        log.info('Context trimmed', {
            before: tokenEstimate,
            after: newEstimate,
            kept: keepCount,
            messagesRemoved: oldMessages.length,
        });
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

        const startTime = Date.now();

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
                this.trimContextIfNeeded();

                // Call the LLM
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
                    }

                    const results = await Promise.all(
                        response.functionCalls.map(fc => executeTool(fc.name, fc.args))
                    );

                    const responseParts: LLMPart[] = response.functionCalls.map((fc, i) => ({
                        functionResponse: {
                            name: fc.name,
                            response: { result: results[i] },
                        },
                    }));

                    // Add tool results to history
                    this.pushMessage({ role: 'user', parts: responseParts });

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
    }

    /**
     * Streaming variant of processMessage.
     * Calls `onToken` for each text chunk as it arrives from the model.
     * Falls back to non-streaming if the provider doesn't support it.
     */
    async processMessageStream(
        userMessage: string,
        onToken: (token: string) => void,
        attachments: Array<{ name: string; type: string; data: string }> = []
    ): Promise<AgentResponse> {
        if (!this.provider.generateContentStream) {
            // Fallback: run non-streaming, emit full text at once
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
        const startTime = Date.now();

        while (iterations < this.config.agent.maxIterations) {
            if (Date.now() - startTime > this.config.agent.timeoutMs) {
                log.warn('Agent loop timed out', { iterations });
                const timeoutMsg = 'I ran out of time processing your request.';
                this.pushMessage({ role: 'model', parts: [{ text: timeoutMsg }] });
                return { text: timeoutMsg, toolsUsed, iterations };
            }

            iterations++;

            try {
                // Trim context if approaching token budget
                this.trimContextIfNeeded();

                // Dynamic model routing: use vision model ONLY when the latest user message has images
                // Only applies to Ollama — other providers handle vision natively
                if (this.activeProvider === 'ollama') {
                    const lastUserMsg = [...this.conversationHistory].reverse().find(m => m.role === 'user');
                    const hasImages = lastUserMsg?.parts.some((p: any) => 'inlineData' in p) ?? false;
                    const oaiProvider = this.provider as any;
                    if (hasImages && oaiProvider.setModel && this.config.ollama?.visionModel) {
                        oaiProvider.setModel(this.config.ollama.visionModel);
                    } else if (!hasImages && oaiProvider.setModel) {
                        oaiProvider.setModel(this.config.ollama?.model || 'qwen3:8b');
                    }
                }

                const response = await this.provider.generateContentStream!(
                    this.systemPrompt,
                    this.conversationHistory,
                    functionDeclarations,
                    onToken
                );
                this.sessionStats.apiCalls++;

                // Tool calls
                if (response.functionCalls && response.functionCalls.length > 0) {
                    this.pushMessage({ role: 'model', parts: response.rawParts });

                    for (const fc of response.functionCalls) {
                        log.info(`Tool call: ${fc.name}`, { args: Object.keys(fc.args) });
                        toolsUsed.push(fc.name);
                        this.sessionStats.toolCalls++;
                        this.sessionStats.toolsUsed[fc.name] = (this.sessionStats.toolsUsed[fc.name] || 0) + 1;
                    }

                    const results = await Promise.all(
                        response.functionCalls.map(fc => executeTool(fc.name, fc.args))
                    );

                    const responseParts: LLMPart[] = response.functionCalls.map((fc, i) => ({
                        functionResponse: {
                            name: fc.name,
                            response: { result: results[i] },
                        },
                    }));

                    this.pushMessage({ role: 'user', parts: responseParts });
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
                    log.warn('Rate limited — failing over to fallback provider', { from: this.activeProvider });
                    this.provider = this.fallbackProvider;
                    this.usingFallback = true;
                    this.activeProvider = this.activeProvider === 'gemini' ? 'ollama' : 'gemini';
                    this.activeModel = this.activeProvider === 'ollama' ? this.config.ollama.model : this.config.gemini.model;
                    onToken('\n\n> ⚡ *Switched to ' + this.activeProvider + ' (failover)*\n\n');
                    continue;
                }

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
                    const timeoutMsg = `The request timed out. Please try again.`;
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
    }

    /**
     * Push a message to history and persist to session store.
     */
    private pushMessage(message: LLMMessage): void {
        this.conversationHistory.push(message);
        try {
            this.sessionStore.saveMessage(this.currentSessionId, message);
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

            const result = await this.provider.generateContent(
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
                const result = await this.provider.generateContent(
                    'You are a title generator. Respond with only the title, nothing else.',
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
     * Only triggers for substantial exchanges (tools used or long messages).
     */
    private extractMemoryAsync(userMessage: string, assistantResponse: string, toolsUsed: string[]): void {
        // Only extract when the conversation was substantial
        const isSubstantial = toolsUsed.length > 0 || userMessage.length > 100;
        if (!isSubstantial) return;

        const memoryDir = this.config.memory.dir;
        const provider = this.provider;

        (async () => {
            try {
                const extractPrompt = `Analyze this conversation and extract facts to store in memory files.

Route each fact to the correct file:
- "user" → personal info, preferences, habits, name, birthday, work style
- "memory" → project details, tech stacks, architecture decisions, workflows

For each fact, specify an action:
- "add" → new information
- "update" → corrects/replaces existing info (include "match" to find the old text)
- "remove" → info is no longer true (include "match" to find text to delete)

For "user" file facts, specify a section: "About Anthony", "Preferences", or "Active Projects".

USER: ${userMessage.slice(0, 500)}
ASSISTANT: ${assistantResponse.slice(0, 500)}

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
                    log.info(`Smart memory update`, { changes: changed, updates: validUpdates.map(u => `${u.action}:${u.file}`) });
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
     * Get the LLM provider (for memory consolidation).
     */
    getProvider(): any {
        return this.provider;
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
