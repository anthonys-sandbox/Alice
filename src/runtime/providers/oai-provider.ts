import { createLogger } from '../../utils/logger.js';
import type { LLMMessage, LLMPart, LLMResponse, FunctionDeclaration } from './gemini.js';

const log = createLogger('OAI');

export interface OAIProviderConfig {
    apiKey?: string;
    model: string;
    baseUrl: string;
    fallbackModel?: string;
}

// ── Internal OpenAI-compatible types ──────────────────────────

interface OAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
}

interface OAITool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, any>;
    };
}

// ── Conversion helpers ────────────────────────────────────────

/**
 * Convert Alice LLMMessage[] (Gemini format) → OpenAI messages.
 */
function toOAIMessages(messages: LLMMessage[]): OAIMessage[] {
    const out: OAIMessage[] = [];

    for (const msg of messages) {
        if (msg.role === 'model') {
            const textParts = msg.parts.filter((p: any) => 'text' in p);
            const fcParts = msg.parts.filter((p: any) => 'functionCall' in p);

            if (fcParts.length > 0) {
                const text = textParts.map((p: any) => p.text).join('') || null;
                out.push({
                    role: 'assistant',
                    content: text,
                    tool_calls: fcParts.map((p: any, i: number) => ({
                        id: `call_${i}_${p.functionCall.name}`,
                        type: 'function' as const,
                        function: {
                            name: p.functionCall.name,
                            arguments: JSON.stringify(p.functionCall.args),
                        },
                    })),
                });
            } else {
                out.push({
                    role: 'assistant',
                    content: textParts.map((p: any) => p.text).join('') || '',
                });
            }
        } else if (msg.role === 'user') {
            const frParts = msg.parts.filter((p: any) => 'functionResponse' in p);
            const textParts = msg.parts.filter((p: any) => 'text' in p);

            if (frParts.length > 0) {
                for (let i = 0; i < frParts.length; i++) {
                    const p = frParts[i] as any;
                    out.push({
                        role: 'tool',
                        tool_call_id: `call_${i}_${p.functionResponse.name}`,
                        content: typeof p.functionResponse.response.result === 'string'
                            ? p.functionResponse.response.result
                            : JSON.stringify(p.functionResponse.response.result),
                    });
                }
            }

            // Check for image parts (inlineData)
            const imageParts = msg.parts.filter((p: any) => 'inlineData' in p);

            if (textParts.length > 0 || imageParts.length > 0) {
                if (imageParts.length > 0) {
                    // Use multi-part content array for vision messages
                    const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
                    for (const tp of textParts) {
                        contentParts.push({ type: 'text', text: (tp as any).text });
                    }
                    for (const ip of imageParts) {
                        const inline = (ip as any).inlineData;
                        contentParts.push({
                            type: 'image_url',
                            image_url: { url: `data:${inline.mimeType};base64,${inline.data}` },
                        });
                    }
                    out.push({ role: 'user', content: contentParts });
                } else {
                    // Text-only: use plain string (more compatible)
                    out.push({
                        role: 'user',
                        content: textParts.map((p: any) => p.text).join(''),
                    });
                }
            }
        }
    }

    return out;
}

/**
 * Convert Alice FunctionDeclaration[] → OpenAI tool format.
 */
function toOAITools(tools: FunctionDeclaration[]): OAITool[] {
    return tools.map(t => ({
        type: 'function' as const,
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        },
    }));
}

// ── Provider class ────────────────────────────────────────────

/**
 * Generic OpenAI-compatible provider (works with Ollama, vLLM, LiteLLM, etc.).
 * Accepts LLMMessage[] and FunctionDeclaration[], returns LLMResponse.
 */
export class OAIProvider {
    private apiKey: string | undefined;
    private model: string;
    private baseUrl: string;
    private fallbackModel: string | undefined;
    public lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;

    constructor(config: OAIProviderConfig) {
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.baseUrl = config.baseUrl;
        this.fallbackModel = config.fallbackModel;
        log.info('Initialized provider', { model: this.model, baseUrl: this.baseUrl });
    }

    /** Dynamically switch model (e.g., for vision requests) */
    setModel(model: string): void {
        if (model !== this.model) {
            log.info('Switching model', { from: this.model, to: model });
            this.model = model;
        }
    }

    async generateContent(
        systemInstruction: string,
        messages: LLMMessage[],
        functionDeclarations: FunctionDeclaration[]
    ): Promise<LLMResponse> {
        log.debug(`Calling ${this.model}`, { messagesCount: messages.length });

        const oaiMessages: OAIMessage[] = [
            { role: 'system', content: systemInstruction },
            ...toOAIMessages(messages),
        ];

        const body: any = {
            model: this.model,
            messages: oaiMessages,
            max_tokens: 4096,
        };

        const oaiTools = toOAITools(functionDeclarations);
        if (oaiTools.length > 0) {
            body.tools = oaiTools;
            body.tool_choice = 'auto';
        }

        const MAX_RETRIES = 3;
        let activeModel = this.model;

        try {
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                };
                if (this.apiKey) {
                    headers['Authorization'] = `Bearer ${this.apiKey}`;
                }

                const response = await fetch(this.baseUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                });

                if (response.status === 429 && attempt < MAX_RETRIES) {
                    const waitMs = Math.pow(2, attempt + 1) * 1000;
                    log.warn(`Rate limited (429), retrying in ${waitMs / 1000}s...`, { attempt: attempt + 1 });
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }

                if (!response.ok) {
                    const errText = await response.text();
                    // If primary model failed and we have a fallback, try it
                    if (this.fallbackModel && activeModel !== this.fallbackModel) {
                        log.warn(`Primary model failed (${response.status}), trying fallback: ${this.fallbackModel}`);
                        body.model = this.fallbackModel;
                        activeModel = this.fallbackModel;
                        continue; // retry with fallback
                    }
                    throw new Error(`OAI API error ${response.status}: ${errText}`);
                }

                const data = await response.json() as any;

                // Track token usage from Ollama
                if (data.usage) {
                    this.lastUsage = {
                        promptTokens: data.usage.prompt_tokens || 0,
                        completionTokens: data.usage.completion_tokens || 0,
                        totalTokens: data.usage.total_tokens || 0,
                    };
                }

                const choice = data.choices?.[0];

                if (!choice) {
                    return { text: null, functionCalls: null, rawParts: [], rawResponse: data };
                }

                const message = choice.message;

                if (message.tool_calls && message.tool_calls.length > 0) {
                    const functionCalls = message.tool_calls
                        .filter((tc: any) => tc.type === 'function')
                        .map((tc: any) => ({
                            name: tc.function.name,
                            args: JSON.parse(tc.function.arguments || '{}'),
                        }));

                    const rawParts: LLMPart[] = [];
                    if (message.content) {
                        rawParts.push({ text: message.content });
                    }
                    for (const fc of functionCalls) {
                        rawParts.push({ functionCall: { name: fc.name, args: fc.args } });
                    }

                    log.debug('Response received', { hasText: !!message.content, functionCallCount: functionCalls.length });

                    return {
                        text: message.content || null,
                        functionCalls: functionCalls.length > 0 ? functionCalls : null,
                        rawParts,
                        rawResponse: data,
                    };
                }

                const text = message.content || null;
                const rawParts: LLMPart[] = text ? [{ text }] : [];

                log.debug('Response received', { hasText: !!text, functionCallCount: 0 });

                return { text, functionCalls: null, rawParts, rawResponse: data };
            }
        } catch (err: any) {
            log.error('API error', { error: err.message });
            throw err;
        }

        throw new Error('OAI provider: all retries exhausted');
    }

    /**
     * Streaming variant — yields text tokens as they arrive.
     * If the model returns tool calls, yields a final LLMResponse with functionCalls.
     * The `onToken` callback fires for each text chunk.
     */
    async generateContentStream(
        systemInstruction: string,
        messages: LLMMessage[],
        functionDeclarations: FunctionDeclaration[],
        onToken: (token: string) => void
    ): Promise<LLMResponse> {
        const oaiMessages: OAIMessage[] = [
            { role: 'system', content: systemInstruction },
            ...toOAIMessages(messages),
        ];

        const body: any = {
            model: this.model,
            messages: oaiMessages,
            max_tokens: 4096,
            stream: true,
        };

        const oaiTools = toOAITools(functionDeclarations);
        if (oaiTools.length > 0) {
            body.tools = oaiTools;
            body.tool_choice = 'auto';
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        const response = await fetch(this.baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OAI API error ${response.status}: ${errText}`);
        }

        if (!response.body) {
            throw new Error('No response body for streaming');
        }

        // Parse SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        const toolCallChunks: Map<number, { name: string; arguments: string }> = new Map();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;
                    if (!trimmed.startsWith('data: ')) continue;

                    try {
                        const data = JSON.parse(trimmed.slice(6));
                        const delta = data.choices?.[0]?.delta;
                        if (!delta) continue;

                        // Text content
                        if (delta.content) {
                            fullText += delta.content;
                            // Filter out qwen3 <think> blocks from user-visible stream
                            if (!fullText.includes('<think>') || fullText.includes('</think>')) {
                                // Only emit content after </think> if there was a think block
                                const cleanContent = delta.content.replace(/<\/?think>/g, '');
                                if (cleanContent) onToken(cleanContent);
                            }
                        }

                        // Tool call deltas (accumulated across chunks)
                        if (delta.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index ?? 0;
                                const existing = toolCallChunks.get(idx) || { name: '', arguments: '' };
                                if (tc.function?.name) existing.name += tc.function.name;
                                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                                toolCallChunks.set(idx, existing);
                            }
                        }
                    } catch {
                        // Skip malformed SSE lines
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        // Clean qwen3 <think> blocks from the accumulated text
        const cleanText = fullText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        // Build response
        if (toolCallChunks.size > 0) {
            const functionCalls = Array.from(toolCallChunks.values()).map(tc => ({
                name: tc.name,
                args: JSON.parse(tc.arguments || '{}'),
            }));

            const rawParts: LLMPart[] = [];
            if (cleanText) rawParts.push({ text: cleanText });
            for (const fc of functionCalls) {
                rawParts.push({ functionCall: { name: fc.name, args: fc.args } });
            }

            return {
                text: cleanText || null,
                functionCalls: functionCalls.length > 0 ? functionCalls : null,
                rawParts,
                rawResponse: null,
            };
        }

        const rawParts: LLMPart[] = cleanText ? [{ text: cleanText }] : [];
        return { text: cleanText || null, functionCalls: null, rawParts, rawResponse: null };
    }
}
