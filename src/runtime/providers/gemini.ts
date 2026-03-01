import { GoogleGenAI } from '@google/genai';
import { createLogger } from '../../utils/logger.js';
import type { AliceConfig } from '../../utils/config.js';
import { hasCliCredentials, getAccessToken, invalidateTokens } from './gemini-cli-auth.js';

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
            // Initialize with a placeholder — we'll inject the real token per-request
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

    /**
     * Build a GoogleGenAI instance with fresh CLI OAuth token.
     * Falls back to API key if token refresh fails.
     */
    private async getAI(): Promise<GoogleGenAI> {
        if (this.authMode !== 'cli') return this.ai;

        const token = await getAccessToken();
        if (!token) {
            // Fallback to API key if available
            if (this.config.gemini.apiKey) {
                log.warn('CLI token unavailable, falling back to API key');
                return new GoogleGenAI({ apiKey: this.config.gemini.apiKey });
            }
            throw new Error(
                'CLI token refresh failed and no API key configured. Re-run: gemini'
            );
        }

        // Create a fresh instance with the Bearer token via httpOptions
        return new GoogleGenAI({
            apiKey: 'cli-oauth',
            httpOptions: {
                headers: { Authorization: `Bearer ${token}` },
                baseUrl: 'https://cloudaicompanion.googleapis.com',
            },
        } as any);
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

        try {
            const ai = await this.getAI();
            const response = await ai.models.generateContent({
                model: this.model,
                contents: messages as any,
                config: {
                    systemInstruction,
                    tools: functionDeclarations.length > 0
                        ? [{ functionDeclarations: functionDeclarations as any }]
                        : undefined,
                },
            });

            // Extract function calls if present
            const functionCalls = response.functionCalls?.map(fc => ({
                name: fc.name!,
                args: fc.args as Record<string, any>,
            })) ?? null;

            // Extract text response
            const text = response.text ?? null;

            // Preserve raw parts (includes thought_signature for function calls)
            const rawParts = (response.candidates?.[0]?.content?.parts as any[]) ?? [];

            log.debug('Response received', {
                hasText: !!text,
                functionCallCount: functionCalls?.length ?? 0,
            });

            return { text, functionCalls, rawParts, rawResponse: response };
        } catch (err: any) {
            // If CLI auth error, invalidate and retry with API key
            if (this.authMode === 'cli' && (err.status === 401 || err.status === 403)) {
                log.warn('CLI auth error, invalidating tokens', { error: err.message });
                invalidateTokens();
            }
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

        try {
            const ai = await this.getAI();
            const response = await ai.models.generateContentStream({
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
                // Stream text chunks
                const chunkText = chunk.text ?? '';
                if (chunkText) {
                    fullText += chunkText;
                    onToken(chunkText);
                }

                // Collect function calls from the final chunk
                if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                    functionCalls = chunk.functionCalls.map(fc => ({
                        name: fc.name!,
                        args: fc.args as Record<string, any>,
                    }));
                }

                // Collect raw parts
                const parts = (chunk.candidates?.[0]?.content?.parts as any[]) ?? [];
                if (parts.length > 0) {
                    rawParts = parts;
                }
            }

            log.debug('Stream complete', {
                hasText: !!fullText,
                functionCallCount: functionCalls?.length ?? 0,
            });

            return {
                text: fullText || null,
                functionCalls,
                rawParts,
                rawResponse: null,
            };
        } catch (err: any) {
            // If CLI auth error, invalidate tokens
            if (this.authMode === 'cli' && (err.status === 401 || err.status === 403)) {
                log.warn('CLI streaming auth error, invalidating tokens', { error: err.message });
                invalidateTokens();
            }
            log.error('Gemini streaming error', { error: err.message });
            // Fall back to non-streaming
            log.info('Falling back to non-streaming');
            const result = await this.generateContent(systemInstruction, messages, functionDeclarations);
            if (result.text) onToken(result.text);
            return result;
        }
    }
}
