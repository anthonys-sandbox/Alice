import { GeminiProvider, type LLMMessage, type LLMResponse, type FunctionDeclaration } from './providers/gemini.js';
import { OAIProvider } from './providers/oai-provider.js';
import { executeTool, toGeminiFunctionDeclarations, getAllTools } from './tools/registry.js';
import { createLogger } from '../utils/logger.js';
import type { AliceConfig } from '../utils/config.js';
import { toolEvents } from './tools/registry.js';

const log = createLogger('SubAgent');

type ChatProvider = {
    generateContent(
        systemInstruction: string,
        messages: LLMMessage[],
        functionDeclarations: FunctionDeclaration[]
    ): Promise<LLMResponse>;
};

export interface SubAgentTask {
    task: string;
    tools?: string[];         // Whitelist of allowed tool names (defaults to all including MCP)
    maxIterations?: number;   // Max ReAct loop iterations (default: 10)
    provider?: 'background' | 'primary';  // Which provider to use (default: background)
    persona?: { name: string; soul: string; identity: string };  // Optional persona to adopt
}

export interface SubAgentResult {
    text: string;
    toolsUsed: string[];
    iterations: number;
    success: boolean;
    error?: string;
}

/**
 * A lightweight sub-agent that runs independently from the main conversation.
 * Used for delegated tasks, parallel research, and background processing.
 * Has its own conversation history and controlled tool access.
 */
export class SubAgent {
    private provider: ChatProvider;
    private conversationHistory: LLMMessage[] = [];
    private taskId: string;

    constructor(
        private config: AliceConfig,
        private primaryProvider: ChatProvider,
        private backgroundProvider: ChatProvider | null,
        private allowedTools: Set<string>,
    ) {
        // Use background provider by default to save primary API quota
        this.provider = backgroundProvider || primaryProvider;
        this.taskId = `sub_${Date.now().toString(36)}`;
    }

    /**
     * Execute a task in an isolated conversation loop.
     */
    async execute(task: SubAgentTask): Promise<SubAgentResult> {
        const maxIter = task.maxIterations ?? 10;
        const toolsUsed: string[] = [];
        let iterations = 0;

        // Use primary provider if explicitly requested
        if (task.provider === 'primary') {
            this.provider = this.primaryProvider;
        }

        // Build system prompt for the sub-agent (persona-aware)
        const personaLines = task.persona
            ? [
                `You are ${task.persona.name}.`,
                task.persona.soul,
                task.persona.identity,
                '',
            ]
            : [];

        const systemPrompt = [
            ...personaLines,
            'You are a focused task-execution agent. Complete the assigned task efficiently.',
            'Use the available tools to gather information and take action.',
            'When the task is complete, respond with your findings/results.',
            'Be concise and structured in your output.',
            `Working directory: ${process.cwd()}`,
        ].join('\n');

        // Build function declarations (includes MCP tools when no whitelist is set)
        const allDecls = toGeminiFunctionDeclarations();
        const filteredDecls = this.allowedTools.size > 0
            ? allDecls.filter(d => this.allowedTools.has(d.name))
            : allDecls;  // Empty whitelist = ALL tools including MCP

        // Add the task as the first user message
        this.conversationHistory.push({
            role: 'user',
            parts: [{ text: task.task }],
        });

        log.info('Sub-agent started', {
            id: this.taskId,
            task: task.task.slice(0, 100),
            tools: filteredDecls.map(d => d.name),
        });

        toolEvents.emit('tool_output', {
            tool: 'delegate_task',
            stream: 'info',
            chunk: `🤖 Sub-agent started: ${task.task.slice(0, 80)}...`,
            command: task.task,
        });

        try {
            while (iterations < maxIter) {
                iterations++;

                const response = await this.provider.generateContent(
                    systemPrompt,
                    this.conversationHistory,
                    filteredDecls,
                );

                // Handle function calls
                if (response.functionCalls && response.functionCalls.length > 0) {
                    // Add model response with function calls
                    this.conversationHistory.push({
                        role: 'model',
                        parts: response.functionCalls.map(fc => ({
                            functionCall: { name: fc.name, args: fc.args },
                        })),
                    });

                    // Execute each function call
                    const functionResponses: any[] = [];
                    for (const fc of response.functionCalls) {
                        if (!this.allowedTools.has(fc.name) && this.allowedTools.size > 0) {
                            functionResponses.push({
                                functionResponse: {
                                    name: fc.name,
                                    response: { error: `Tool "${fc.name}" is not available for this task.` },
                                },
                            });
                            continue;
                        }

                        toolsUsed.push(fc.name);
                        toolEvents.emit('tool_output', {
                            tool: 'delegate_task',
                            stream: 'info',
                            chunk: `  🔧 Sub-agent using: ${fc.name}`,
                            command: task.task,
                        });

                        const result = await executeTool(fc.name, fc.args || {});

                        // Truncate large results to stay within context
                        const truncated = result.length > 3000
                            ? result.slice(0, 3000) + '\n... (truncated)'
                            : result;

                        functionResponses.push({
                            functionResponse: {
                                name: fc.name,
                                response: { result: truncated },
                            },
                        });
                    }

                    this.conversationHistory.push({
                        role: 'user',
                        parts: functionResponses,
                    });
                } else {
                    // No function calls — sub-agent has finished
                    const text = response.text || '(no response)';

                    toolEvents.emit('tool_output', {
                        tool: 'delegate_task',
                        stream: 'info',
                        chunk: `✅ Sub-agent completed (${iterations} iterations, ${toolsUsed.length} tool calls)`,
                        command: task.task,
                    });

                    return {
                        text,
                        toolsUsed: [...new Set(toolsUsed)],
                        iterations,
                        success: true,
                    };
                }
            }

            // Max iterations reached
            return {
                text: 'Sub-agent reached maximum iterations without completing the task.',
                toolsUsed: [...new Set(toolsUsed)],
                iterations,
                success: false,
                error: 'Max iterations reached',
            };
        } catch (err: any) {
            log.error('Sub-agent failed', { id: this.taskId, error: err.message });
            return {
                text: `Sub-agent error: ${err.message}`,
                toolsUsed: [...new Set(toolsUsed)],
                iterations,
                success: false,
                error: err.message,
            };
        }
    }

    /**
     * Run multiple tasks in parallel and return all results.
     * Each task gets its own independent sub-agent.
     */
    static async runParallel(
        tasks: SubAgentTask[],
        config: AliceConfig,
        primaryProvider: ChatProvider,
        backgroundProvider: ChatProvider | null,
    ): Promise<SubAgentResult[]> {
        const promises = tasks.map(task => {
            const allowedTools = task.tools
                ? new Set<string>(task.tools)
                : new Set<string>();

            const agent = new SubAgent(config, primaryProvider, backgroundProvider, allowedTools);
            return agent.execute(task);
        });

        return Promise.all(promises);
    }
}
