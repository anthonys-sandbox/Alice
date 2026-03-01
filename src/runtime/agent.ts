import { GeminiProvider, type LLMMessage, type LLMPart, type LLMResponse, type FunctionDeclaration } from './providers/gemini.js';
import { OAIProvider } from './providers/oai-provider.js';
import { executeTool, toGeminiFunctionDeclarations, registerTool } from './tools/registry.js';
import { loadMemory, buildSystemPrompt, appendDailyLog, appendFacts, searchMemoryFiles } from '../memory/index.js';
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
    private config: AliceConfig;
    private conversationHistory: LLMMessage[] = [];
    private systemPrompt: string = '';
    private sessionStore: SessionStore;
    private currentSessionId: string;

    constructor(config: AliceConfig) {
        this.config = config;

        if (config.chatProvider === 'gemini') {
            log.info('Using Gemini as chat provider');
            this.provider = new GeminiProvider(config);
        } else {
            // ollama (default)
            log.info('Using Ollama (local) as chat provider');
            this.provider = new OAIProvider({
                model: config.ollama.model,
                baseUrl: `http://${config.ollama.host}:${config.ollama.port}/v1/chat/completions`,
            });
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

        this.refreshContext();
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
        // Token budget: qwen3:8b has 32K context, leave room for system prompt + response
        const MAX_CONTEXT_TOKENS = 24000; // ~75% of 32K
        const KEEP_RECENT = 20; // Always keep the last N messages

        const tokenEstimate = this.estimateTokens(this.conversationHistory);
        if (tokenEstimate <= MAX_CONTEXT_TOKENS) return;

        log.warn('Context approaching token limit, trimming', {
            estimated: tokenEstimate,
            max: MAX_CONTEXT_TOKENS,
            messageCount: this.conversationHistory.length,
        });

        if (this.conversationHistory.length <= KEEP_RECENT) return;

        // Summarize old messages
        const oldMessages = this.conversationHistory.slice(0, -KEEP_RECENT);
        const recentMessages = this.conversationHistory.slice(-KEEP_RECENT);

        // Build a simple summary of the older context
        const summaryParts: string[] = [];
        for (const msg of oldMessages) {
            const textParts = msg.parts
                .filter((p: any) => 'text' in p && p.text)
                .map((p: any) => p.text?.slice(0, 100));
            if (textParts.length > 0) {
                summaryParts.push(`[${msg.role}]: ${textParts.join(' ')}`);
            }
        }

        const summaryText = `[Context summary — ${oldMessages.length} earlier messages compressed]\n${summaryParts.slice(0, 10).join('\n')}`;

        this.conversationHistory = [
            { role: 'user', parts: [{ text: summaryText }] },
            ...recentMessages,
        ];

        const newEstimate = this.estimateTokens(this.conversationHistory);
        log.info('Context trimmed', {
            before: tokenEstimate,
            after: newEstimate,
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
                const isRateLimit = errorMessage.includes('429') || errorMessage.includes('rate limit');
                const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT');
                const isModelError = errorMessage.includes('400') || errorMessage.includes('invalid');

                if (isRateLimit && iterations < this.config.agent.maxIterations) {
                    // Exponential backoff for rate limiting
                    const waitMs = Math.pow(2, iterations) * 1000;
                    log.warn(`Rate limited, waiting ${waitMs}ms before retry`);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }

                if (isTimeout) {
                    // Timeout errors — don't retry, just report
                    const timeoutMsg = `The request timed out. The model or service may be under load. Please try again.`;
                    this.pushMessage({ role: 'model', parts: [{ text: timeoutMsg }] });
                    return { text: timeoutMsg, toolsUsed, iterations };
                }

                // For other errors, give the model context to self-correct if iterations remain
                if (iterations >= this.config.agent.maxIterations) {
                    const errorMsg = `I encountered an error after ${iterations} attempts: ${errorMessage}. Please try again.`;
                    this.pushMessage({ role: 'model', parts: [{ text: errorMsg }] });
                    return { text: errorMsg, toolsUsed, iterations };
                }

                // Inject error context for self-correction
                const recoveryHint = isModelError
                    ? `The previous request was malformed. Please simplify the approach and try again.`
                    : `An error occurred: ${errorMessage}. Adjusting approach and retrying.`;

                this.pushMessage({
                    role: 'model',
                    parts: [{ text: recoveryHint }],
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
                const lastUserMsg = [...this.conversationHistory].reverse().find(m => m.role === 'user');
                const hasImages = lastUserMsg?.parts.some((p: any) => 'inlineData' in p) ?? false;
                const oaiProvider = this.provider as any;
                if (hasImages && oaiProvider.setModel && this.config.ollama?.visionModel) {
                    oaiProvider.setModel(this.config.ollama.visionModel);
                } else if (!hasImages && oaiProvider.setModel) {
                    oaiProvider.setModel(this.config.ollama?.model || 'qwen3:8b');
                }

                const response = await this.provider.generateContentStream!(
                    this.systemPrompt,
                    this.conversationHistory,
                    functionDeclarations,
                    onToken
                );

                // Tool calls
                if (response.functionCalls && response.functionCalls.length > 0) {
                    this.pushMessage({ role: 'model', parts: response.rawParts });

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

                const isRateLimit = errorMessage.includes('429') || errorMessage.includes('rate limit');
                const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT');

                if (isRateLimit && iterations < this.config.agent.maxIterations) {
                    const waitMs = Math.pow(2, iterations) * 1000;
                    log.warn(`Rate limited, waiting ${waitMs}ms before retry`);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }

                if (isTimeout) {
                    const timeoutMsg = `The request timed out. Please try again.`;
                    this.pushMessage({ role: 'model', parts: [{ text: timeoutMsg }] });
                    return { text: timeoutMsg, toolsUsed, iterations };
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
                const extractPrompt = `Analyze this conversation exchange and extract any important facts worth remembering long-term. Focus on:
- User preferences, habits, or personal details
- Project names, tech stacks, or architecture decisions
- Tool configurations or environment details
- Recurring patterns or workflows

USER: ${userMessage.slice(0, 500)}

ASSISTANT: ${assistantResponse.slice(0, 500)}

TOOLS USED: ${toolsUsed.join(', ') || 'none'}

Respond with ONLY a bullet list of facts (one per line, starting with "- "). If there are no meaningful facts to extract, respond with "NONE".`;

                const result = await provider.generateContent(
                    'You are a fact extraction system. Extract only concrete, specific facts. Be concise. Never include opinions or speculation.',
                    [{ role: 'user', parts: [{ text: extractPrompt }] }],
                    []
                );

                const text = (result.text || '').trim();
                if (text === 'NONE' || text.length < 5) return;

                // Parse bullet points
                const facts = text.split('\n')
                    .map(line => line.trim())
                    .filter(line => line.startsWith('-') || line.startsWith('•') || line.startsWith('*'))
                    .map(line => line.replace(/^[-•*]\s*/, '').trim())
                    .filter(fact => fact.length >= 10);

                if (facts.length === 0) return;

                const appended = await appendFacts(memoryDir, facts);
                if (appended > 0) {
                    log.info(`Auto-learned ${appended} facts from conversation`);
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
}
