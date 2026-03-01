import { GoogleGenAI } from '@google/genai';
import { createLogger } from '../../utils/logger.js';
import type { AliceConfig } from '../../utils/config.js';
import { hasCliCredentials, invalidateTokens } from './gemini-cli-auth.js';
import * as CodeAssist from './code-assist-client.js';

const log = createLogger('Gemini');

export interface LLMMessage {
    role: 'user' | 'model';
    parts: LLMPart[];
}

export type LLMPart =
    | { text: string }
    | { functionCall: { name: string; args: Record<string, any> } }
    | { functionResponse: { name: string; response: { result: any } } };

export interface FunctionDeclaration {
    name: string;
    description: string;
    parameters: Record<string, any>;
}

export interface LLMResponse {
    text: string | null;
    functionCalls: Array<{ name: string; args: Record<string, any> }> | null;
    rawParts: any[]; // Raw parts from the model — preserves thought_signature
    rawResponse: any;
}

export type GeminiAuthMode = 'api-key' | 'cli' | 'auto';

export class GeminiProvider {
    private ai: GoogleGenAI;
    private model: string;
    private authMode: 'api-key' | 'cli';
    private config: AliceConfig;

    constructor(config: AliceConfig) {
        this.config = config;
        this.model = config.gemini.model;

        const requestedAuth = config.gemini.auth || 'auto';

        // Resolve auth mode
        if (requestedAuth === 'cli' || (requestedAuth === 'auto' && hasCliCredentials())) {
            if (!hasCliCredentials()) {
                throw new Error(
                    'GEMINI_AUTH=cli but no CLI credentials found. Run: npm i -g @google/gemini-cli && gemini'
                );
            }
            this.authMode = 'cli';
            // CLI mode uses the Code Assist API directly — no GoogleGenAI SDK needed
            // But we still need a placeholder for the ai field
            this.ai = new GoogleGenAI({ apiKey: 'cli-placeholder' });
            log.info('Initialized Gemini provider (CLI/Ultra auth)', { model: this.model });
        } else {
            // API key mode
            if (!config.gemini.apiKey) {
                throw new Error('GEMINI_API_KEY is required. Set it in .env or alice.config.json');
            }
            this.authMode = 'api-key';
            this.ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
            log.info('Initialized Gemini provider (API key auth)', { model: this.model });
        }
    }

    /** Get the current auth mode label for UI display */
    getAuthLabel(): string {
        return this.authMode === 'cli' ? 'Ultra' : 'API';
    }

    async generateContent(
        systemInstruction: string,
        messages: LLMMessage[],
        functionDeclarations: FunctionDeclaration[]
    ): Promise<LLMResponse> {
        log.debug(`Calling ${this.model}`, {
            messagesCount: messages.length,
            toolsCount: functionDeclarations.length,
        });

        // ── CLI / Code Assist path ──
        if (this.authMode === 'cli') {
            return this.generateContentViaCodeAssist(systemInstruction, messages, functionDeclarations);
        }

        // ── API key path (standard SDK) ──
        try {
            const response = await this.ai.models.generateContent({
                model: this.model,
                contents: messages as any,
                config: {
                    systemInstruction,
                    tools: functionDeclarations.length > 0
                        ? [{ functionDeclarations: functionDeclarations as any }]
                        : undefined,
                },
            });

            return this.parseGenAIResponse(response);
        } catch (err: any) {
            log.error('Gemini API error', { error: err.message });
            throw err;
        }
    }

    /**
     * Streaming variant — yields text tokens as they arrive.
     */
    async generateContentStream(
        systemInstruction: string,
        messages: LLMMessage[],
        functionDeclarations: FunctionDeclaration[],
        onToken: (token: string) => void
    ): Promise<LLMResponse> {
        log.debug(`Streaming call to ${this.model}`, {
            messagesCount: messages.length,
            toolsCount: functionDeclarations.length,
        });

        // ── CLI / Code Assist path ──
        if (this.authMode === 'cli') {
            return this.streamViaCodeAssist(systemInstruction, messages, functionDeclarations, onToken);
        }

        // ── API key path (standard SDK) ──
        try {
            const response = await this.ai.models.generateContentStream({
                model: this.model,
                contents: messages as any,
                config: {
                    systemInstruction,
                    tools: functionDeclarations.length > 0
                        ? [{ functionDeclarations: functionDeclarations as any }]
                        : undefined,
                },
            });

            let fullText = '';
            let functionCalls: Array<{ name: string; args: Record<string, any> }> | null = null;
            let rawParts: any[] = [];

            for await (const chunk of response) {
                const chunkText = chunk.text ?? '';
                if (chunkText) {
                    fullText += chunkText;
                    onToken(chunkText);
                }

                if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                    functionCalls = chunk.functionCalls.map(fc => ({
                        name: fc.name!,
                        args: fc.args as Record<string, any>,
                    }));
                }

                const parts = (chunk.candidates?.[0]?.content?.parts as any[]) ?? [];
                if (parts.length > 0) {
                    rawParts = parts;
                }
            }

            log.debug('Stream complete', {
                hasText: !!fullText,
                functionCallCount: functionCalls?.length ?? 0,
            });

            return { text: fullText || null, functionCalls, rawParts, rawResponse: null };
        } catch (err: any) {
            log.error('Gemini streaming error', { error: err.message });
            // Fall back to non-streaming
            log.info('Falling back to non-streaming');
            const result = await this.generateContent(systemInstruction, messages, functionDeclarations);
            if (result.text) onToken(result.text);
            return result;
        }
    }

    // ──────── Code Assist API methods ────────

    /**
     * Generate content via the Code Assist API (CLI auth mode).
     */
    private async generateContentViaCodeAssist(
        systemInstruction: string,
        messages: LLMMessage[],
        functionDeclarations: FunctionDeclaration[]
    ): Promise<LLMResponse> {
        try {
            const tools = functionDeclarations.length > 0
                ? [{ functionDeclarations }]
                : undefined;

            const resp = await CodeAssist.generateContent(
                this.model,
                messages,
                systemInstruction,
                tools,
            );

            return this.parseRawResponse(resp);
        } catch (err: any) {
            if (err.message?.includes('401') || err.message?.includes('403')) {
                log.warn('CLI auth error, invalidating tokens', { error: err.message });
                invalidateTokens();
                CodeAssist.resetCodeAssistState();

                // Fallback to API key if available
                if (this.config.gemini.apiKey) {
                    log.info('Falling back to API key');
                    this.authMode = 'api-key';
                    this.ai = new GoogleGenAI({ apiKey: this.config.gemini.apiKey });
                    return this.generateContent(systemInstruction, messages, functionDeclarations);
                }
            }
            log.error('Code Assist API error', { error: err.message });
            throw err;
        }
    }

    /**
     * Stream content via the Code Assist API (CLI auth mode).
     */
    private async streamViaCodeAssist(
        systemInstruction: string,
        messages: LLMMessage[],
        functionDeclarations: FunctionDeclaration[],
        onToken: (token: string) => void,
    ): Promise<LLMResponse> {
        try {
            const tools = functionDeclarations.length > 0
                ? [{ functionDeclarations }]
                : undefined;

            let fullText = '';
            let functionCalls: Array<{ name: string; args: Record<string, any> }> | null = null;
            let rawParts: any[] = [];

            const stream = CodeAssist.streamGenerateContent(
                this.model,
                messages,
                systemInstruction,
                tools,
            );

            for await (const chunk of stream) {
                // Extract text from chunk
                const candidates = chunk.candidates ?? [];
                for (const candidate of candidates) {
                    const parts = candidate.content?.parts ?? [];
                    for (const part of parts) {
                        if (part.text) {
                            fullText += part.text;
                            onToken(part.text);
                        }
                        if (part.functionCall) {
                            if (!functionCalls) functionCalls = [];
                            functionCalls.push({
                                name: part.functionCall.name,
                                args: part.functionCall.args || {},
                            });
                        }
                    }
                    if (parts.length > 0) {
                        rawParts = parts;
                    }
                }
            }

            log.debug('Code Assist stream complete', {
                hasText: !!fullText,
                functionCallCount: functionCalls?.length ?? 0,
            });

            return { text: fullText || null, functionCalls, rawParts, rawResponse: null };
        } catch (err: any) {
            log.error('Code Assist streaming error', { error: err.message });

            if (err.message?.includes('401') || err.message?.includes('403')) {
                invalidateTokens();
                CodeAssist.resetCodeAssistState();
            }

            // Don't fall back on rate limits — let the agent's retry loop handle it
            // Falling back would just make another request that also gets 429'd
            if (err.message?.includes('429')) {
                throw err;
            }

            // Fall back to non-streaming for other errors
            log.info('Falling back to non-streaming Code Assist');
            return this.generateContentViaCodeAssist(systemInstruction, messages, functionDeclarations);
        }
    }

    /**
     * Parse a standard GoogleGenAI SDK response into LLMResponse.
     */
    private parseGenAIResponse(response: any): LLMResponse {
        const functionCalls = response.functionCalls?.map((fc: any) => ({
            name: fc.name!,
            args: fc.args as Record<string, any>,
        })) ?? null;

        const text = response.text ?? null;
        const rawParts = (response.candidates?.[0]?.content?.parts as any[]) ?? [];

        log.debug('Response received', {
            hasText: !!text,
            functionCallCount: functionCalls?.length ?? 0,
        });

        return { text, functionCalls, rawParts, rawResponse: response };
    }

    /**
     * Parse a raw Code Assist API response into LLMResponse.
     */
    private parseRawResponse(resp: any): LLMResponse {
        const candidates = resp.candidates ?? [];
        let text: string | null = null;
        let functionCalls: Array<{ name: string; args: Record<string, any> }> | null = null;
        let rawParts: any[] = [];

        for (const candidate of candidates) {
            const parts = candidate.content?.parts ?? [];
            rawParts = parts;
            for (const part of parts) {
                if (part.text) {
                    text = (text || '') + part.text;
                }
                if (part.functionCall) {
                    if (!functionCalls) functionCalls = [];
                    functionCalls.push({
                        name: part.functionCall.name,
                        args: part.functionCall.args || {},
                    });
                }
            }
        }

        log.debug('Code Assist response parsed', {
            hasText: !!text,
            functionCallCount: functionCalls?.length ?? 0,
        });

        return { text, functionCalls, rawParts, rawResponse: resp };
    }
}
