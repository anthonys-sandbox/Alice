import { Bot, InputFile, type Context } from 'grammy';
import { createReadStream, existsSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import type { Agent } from '../runtime/agent.js';
import type { AliceConfig } from '../utils/config.js';

const log = createLogger('Telegram');

/**
 * Telegram channel adapter — Grammy long-poll bot.
 *
 * Handles text and voice messages from whitelisted user IDs.
 * Routes all messages through the shared Agent instance.
 * Supports voice transcription (Gemini) and TTS voice replies (ElevenLabs).
 */
export class TelegramAdapter {
    private bot: Bot | null = null;
    private agent: Agent | null = null;
    private config: AliceConfig;

    constructor(config: AliceConfig) {
        this.config = config;
    }

    setAgent(agent: Agent): void {
        this.agent = agent;
    }

    get isConfigured(): boolean {
        return !!(this.config.telegram?.botToken);
    }

    async start(): Promise<void> {
        if (!this.isConfigured) {
            log.warn('Telegram not configured — set TELEGRAM_BOT_TOKEN in .env');
            return;
        }

        if (!this.agent) {
            log.error('Agent not bound — call setAgent() before start()');
            return;
        }

        this.bot = new Bot(this.config.telegram!.botToken);
        const allowedIds = this.config.telegram!.allowedUserIds;

        // Whitelist guard — applied to ALL message types
        this.bot.use(async (ctx, next) => {
            const userId = ctx.from?.id;
            if (userId === undefined || (allowedIds.size > 0 && !allowedIds.has(userId))) {
                log.debug('Ignoring message from unlisted user', { userId });
                return;
            }
            await next();
        });

        // Text message handler
        this.bot.on('message:text', async (ctx: Context) => {
            const msg = ctx.message;
            const text = msg?.text;
            if (!text || !msg) return;
            log.info(`💬 Text from ${ctx.from?.username || ctx.from?.id}: ${text.slice(0, 80)}`);
            await this.handleMessage(ctx, text, msg.message_id, false);
        });

        // Voice message handler
        this.bot.on('message:voice', async (ctx: Context) => {
            const msg = ctx.message;
            const voice = msg?.voice;
            if (!voice || !msg) return;

            log.info(`🎙️ Voice from ${ctx.from?.username || ctx.from?.id}`);

            const statusMsg = await ctx.reply('🎙️ transcribing…', {
                reply_parameters: { message_id: msg.message_id },
            });

            let transcript: string;
            try {
                const file = await ctx.api.getFile(voice.file_id);
                const fileUrl = `https://api.telegram.org/file/bot${this.config.telegram!.botToken}/${file.file_path}`;
                transcript = await this.transcribeAudio(fileUrl);
                log.info(`📝 Transcribed: "${transcript.slice(0, 80)}"`);
            } catch (err: any) {
                await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => { });
                log.error('Voice transcription failed', { error: err.message });
                await ctx.reply('❌ Transcription failed. Check logs for details.', {
                    reply_parameters: { message_id: msg.message_id },
                });
                return;
            }

            await ctx.api
                .editMessageText(
                    ctx.chat!.id,
                    statusMsg.message_id,
                    `🎙️ _"${transcript}"_\n\n⏳ thinking…`,
                    { parse_mode: 'Markdown' },
                )
                .catch(() => { });

            const voiceReply = !!(this.config.telegram?.elevenLabsApiKey);
            await this.handleMessage(ctx, transcript, msg.message_id, voiceReply, statusMsg.message_id);
        });

        // Error handler
        this.bot.catch((err) => {
            log.error('Grammy unhandled error', { error: err.message });
        });

        log.info('🤖 Starting Telegram bot (long-polling)…');
        // Start in background — non-blocking
        this.bot.start({
            onStart: (info) => {
                log.info(`✅ Telegram bot started — @${info.username}`);
            },
        }).catch((err: any) => {
            log.error('Telegram bot crashed', { error: err.message });
        });
    }

    async stop(): Promise<void> {
        if (this.bot) {
            await this.bot.stop();
            log.info('Telegram bot stopped');
        }
    }

    /**
     * Send a plain text message to a Telegram chat ID.
     * Used by heartbeat and proactive notifications.
     */
    async sendMessage(chatId: number | string, text: string): Promise<void> {
        if (!this.bot) return;
        try {
            await this.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (err: any) {
            log.error('Failed to send Telegram message', { chatId, error: err.message });
        }
    }

    /**
     * Broadcast a message to all allowed user IDs.
     * Used by heartbeat reports.
     */
    async broadcast(text: string): Promise<void> {
        if (!this.bot || !this.config.telegram?.allowedUserIds) return;
        for (const userId of this.config.telegram.allowedUserIds) {
            await this.sendMessage(userId, text);
        }
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private async handleMessage(
        ctx: Context,
        userText: string,
        replyToId: number,
        sendVoice: boolean,
        existingStatusId?: number,
    ): Promise<void> {
        let thinkingId: number;

        if (existingStatusId !== undefined) {
            thinkingId = existingStatusId;
        } else {
            const thinkingMsg = await ctx.reply('⏳ thinking…', {
                reply_parameters: { message_id: replyToId },
            });
            thinkingId = thinkingMsg.message_id;
        }

        try {
            if (!this.agent) throw new Error('Agent not initialized');

            // Handle slash commands locally
            const trimmed = userText.trim().toLowerCase();
            if (trimmed.startsWith('/')) {
                const cmdResult = this.handleCommand(trimmed);
                if (cmdResult !== null) {
                    await ctx.api.deleteMessage(ctx.chat!.id, thinkingId).catch(() => { });
                    await ctx.reply(cmdResult, {
                        parse_mode: 'Markdown',
                        reply_parameters: { message_id: replyToId },
                    });
                    return;
                }
            }

            const result = await this.agent.processMessage(userText);
            await ctx.api.deleteMessage(ctx.chat!.id, thinkingId).catch(() => { });

            log.info('Agent response', {
                tools: result.toolsUsed.length,
                iterations: result.iterations,
            });

            if (sendVoice && this.config.telegram?.elevenLabsApiKey) {
                try {
                    const audio = await this.textToSpeech(result.text);
                    await ctx.replyWithVoice(new InputFile(audio, 'reply.mp3'), {
                        reply_parameters: { message_id: replyToId },
                    });
                    return;
                } catch (err: any) {
                    log.warn('TTS failed, falling back to text', { error: err.message });
                }
            }

            await ctx.reply(result.text, {
                parse_mode: 'Markdown',
                reply_parameters: { message_id: replyToId },
            });
        } catch (err: any) {
            await ctx.api.deleteMessage(ctx.chat!.id, thinkingId).catch(() => { });
            log.error('Agent error', { error: err.message });
            await ctx.reply('❌ Something went wrong. Check the server logs.', {
                reply_parameters: { message_id: replyToId },
            });
        }
    }

    private handleCommand(command: string): string | null {
        const cmd = command.split(/\s+/)[0];

        switch (cmd) {
            case '/status': {
                if (!this.agent) return '❓ Agent not running.';
                const s = this.agent.getStatus();
                return [
                    '📊 *Session Status*',
                    `• Session: \`${s.sessionId.slice(0, 8)}...\``,
                    `• Messages: ${s.messageCount}`,
                    `• Model: ${s.model}`,
                    `• System prompt: ${s.systemPromptChars} chars`,
                    `• Est. context: ~${s.estimatedTokens} tokens`,
                ].join('\n');
            }
            case '/reset':
            case '/new':
                this.agent?.clearHistory();
                this.agent?.refreshContext();
                return '🔄 Session reset. Fresh start!';
            case '/help':
                return [
                    '*Available Commands:*',
                    '• `/status` — Session info',
                    '• `/reset` or `/new` — Start a fresh session',
                    '• `/help` — Show this help',
                ].join('\n');
            default:
                return null; // Unknown command — pass to agent
        }
    }

    /**
     * Transcribe a voice file URL using Gemini's native audio understanding.
     * Falls back to OpenAI Whisper if OpenAI key is set and Gemini key is not.
     */
    private async transcribeAudio(fileUrl: string): Promise<string> {
        const geminiKey = this.config.gemini?.apiKey;

        if (geminiKey) {
            // Use Gemini (no extra key needed — same one as the LLM)
            const { GoogleGenAI } = await import('@google/genai');
            const genAI = new GoogleGenAI({ apiKey: geminiKey });
            const audioResp = await fetch(fileUrl);
            if (!audioResp.ok) throw new Error(`Failed to download voice file: HTTP ${audioResp.status}`);
            const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
            const base64Audio = audioBuffer.toString('base64');

            const result = await genAI.models.generateContent({
                model: this.config.gemini?.model || 'gemini-2.0-flash',
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { inlineData: { mimeType: 'audio/ogg', data: base64Audio } },
                            { text: 'Transcribe this audio exactly as spoken. Return only the transcription text, nothing else.' },
                        ],
                    },
                ],
            });
            return result.text?.trim() || '';
        }

        // Fallback: OpenAI Whisper
        const openaiKey = process.env.OPENAI_API_KEY;
        if (openaiKey) {
            const { OpenAI } = await import('openai');
            const openai = new OpenAI({ apiKey: openaiKey });
            const audioResp = await fetch(fileUrl);
            if (!audioResp.ok) throw new Error(`Failed to download voice file: HTTP ${audioResp.status}`);
            const audioBuffer = await audioResp.blob();
            const file = new File([audioBuffer], 'voice.ogg', { type: 'audio/ogg' });
            const transcription = await openai.audio.transcriptions.create({
                file,
                model: 'whisper-1',
            });
            return transcription.text.trim();
        }

        throw new Error('No transcription provider configured. Set GEMINI_API_KEY or OPENAI_API_KEY.');
    }

    /**
     * Convert text to speech using ElevenLabs.
     */
    private async textToSpeech(text: string): Promise<Buffer> {
        const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
        const client = new ElevenLabsClient({ apiKey: this.config.telegram!.elevenLabsApiKey! });
        const voiceId = this.config.telegram?.elevenLabsVoiceId || '21m00Tcm4TlvDq8ikWAM';

        const response = await client.textToSpeech.convert(voiceId, {
            text,
            modelId: 'eleven_turbo_v2_5',
            outputFormat: 'mp3_44100_128',
        });

        const chunks: Uint8Array[] = [];
        const reader = response.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
        }
        return Buffer.concat(chunks);
    }
}
