import express from 'express';
import { GoogleGenAI, Modality } from '@google/genai';
import type { Session as LiveSession, LiveServerMessage } from '@google/genai';
import { hostname } from 'os';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { Agent } from '../runtime/agent.js';
import { GoogleChatAdapter } from '../channels/google-chat.js';
import { startHeartbeat, stopHeartbeat } from '../scheduler/heartbeat.js';
import { startMeetingPrep, stopMeetingPrep } from '../scheduler/meeting-prep.js';
import { startEmailWatcher, stopEmailWatcher } from '../scheduler/email-watcher.js';
import { scheduler } from '../scheduler/task-scheduler.js';
import { createLogger } from '../utils/logger.js';
import type { AliceConfig } from '../utils/config.js';
import { formatForGoogleChat } from '../utils/markdown.js';
import { MCPManager } from '../mcp/client.js';
import { getMemoryStore } from '../memory/index.js';
import { CronJobManager } from '../scheduler/cron-jobs.js';
import { registerCronTools, toolEvents } from '../runtime/tools/registry.js';
import { FileWatcher } from '../runtime/file-watcher.js';

const log = createLogger('Gateway');

export class Gateway {
  private app: express.Application;
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private agent: Agent;
  private chat: GoogleChatAdapter;
  private config: AliceConfig;
  private mcp: MCPManager;
  private cronJobs: CronJobManager;
  private fileWatcher: FileWatcher | null = null;

  constructor(config: AliceConfig) {
    this.config = config;
    this.app = express();
    this.app.use(express.json());
    this.app.use(express.static('public'));
    this.app.use('/images', express.static('generated_images'));
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.agent = new Agent(config);
    this.chat = new GoogleChatAdapter(
      config.googleChat.sheetId,
      config.googleChat.oauthClientId,
      config.googleChat.oauthClientSecret,
      config.googleChat.serviceAccountKeyPath
    );
    this.chat.setAgent(this.agent);

    // Initialize MCP connections in background
    this.mcp = new MCPManager();
    if (config.mcp.servers.length > 0) {
      this.mcp.connectAll(config.mcp.servers).catch(err => {
        log.warn('MCP initialization had errors (non-fatal)', { error: err.message });
      });
    }

    // Initialize cron job manager
    const dataDir = join(resolve(config.memory.dir), 'data');
    this.cronJobs = new CronJobManager(dataDir);
    this.cronJobs.setAgent(this.agent);
    this.cronJobs.setChat(this.chat);
    registerCronTools(this.cronJobs);

    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupRoutes(): void {
    // Health check
    const healthHandler = (_req: any, res: any) => {
      res.json({ status: 'ok', uptime: process.uptime() });
    };
    this.app.get('/health', healthHandler);
    this.app.get('/api/health', healthHandler);

    // Speech-to-text transcription via native macOS SFSpeechRecognizer
    this.app.post('/api/transcribe', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
      try {
        const audioBuffer = req.body as Buffer;
        if (!audioBuffer || audioBuffer.length === 0) {
          res.status(400).json({ error: 'No audio data received' });
          return;
        }

        const ts = Date.now();
        const wavFile = join(tmpdir(), `alice-audio-${ts}.wav`);
        const outFile = join(tmpdir(), `alice-transcribe-${ts}.txt`);
        writeFileSync(wavFile, audioBuffer);

        const transcribeApp = new URL('../../scripts/Transcribe.app', import.meta.url).pathname;
        if (!existsSync(transcribeApp)) {
          try { unlinkSync(wavFile); } catch { }
          res.status(500).json({ error: 'Transcribe app not found' });
          return;
        }

        // Launch Transcribe.app with args: <audio-file> <output-file>
        execFile('/usr/bin/open', [transcribeApp, '--args', wavFile, outFile], (openErr) => {
          if (openErr) {
            try { unlinkSync(wavFile); } catch { }
            res.status(500).json({ error: 'Failed to launch transcriber' });
            return;
          }

          // Poll for output file (app writes result and exits)
          let attempts = 0;
          const maxAttempts = 50; // 25 seconds
          const poller = setInterval(() => {
            attempts++;
            if (existsSync(outFile)) {
              clearInterval(poller);
              const result = readFileSync(outFile, 'utf-8').trim();
              try { unlinkSync(wavFile); } catch { }
              try { unlinkSync(outFile); } catch { }

              if (result.startsWith('ERROR:')) {
                res.status(500).json({ error: result.slice(7) });
              } else {
                res.json({ text: result });
              }
            } else if (attempts >= maxAttempts) {
              clearInterval(poller);
              try { unlinkSync(wavFile); } catch { }
              res.status(500).json({ error: 'Transcription timed out' });
            }
          }, 500);
        });
      } catch (err: any) {
        log.warn('Transcribe endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
      }
    });

    // Text-to-speech synthesis via macOS say command
    this.app.post('/api/tts', express.json(), async (req, res) => {
      try {
        const { text } = req.body;
        if (!text) {
          res.status(400).json({ error: 'No text provided' });
          return;
        }

        const ts = Date.now();
        const aiffFile = join(tmpdir(), `alice-tts-api-${ts}.aiff`);
        const wavFile = join(tmpdir(), `alice-tts-api-${ts}.wav`);
        const voice = process.env.MACOS_VOICE || '';
        const rate = process.env.MACOS_VOICE_RATE || '190';
        const sayArgs = [...(voice ? ['-v', voice] : []), '-r', rate, '-o', aiffFile, text.slice(0, 1500)];
        await new Promise<void>((resolve, reject) => {
          execFile('/usr/bin/say', sayArgs, (err) => { if (err) reject(err); else resolve(); });
        });
        await new Promise<void>((resolve, reject) => {
          execFile('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', aiffFile, wavFile], (err) => { if (err) reject(err); else resolve(); });
        });
        const audioBuffer = readFileSync(wavFile);
        try { unlinkSync(aiffFile); } catch { }
        try { unlinkSync(wavFile); } catch { }
        res.set('Content-Type', 'audio/wav');
        res.send(audioBuffer);
      } catch (err: any) {
        log.warn('TTS endpoint error', { error: err.message });
        // Fall back gracefully — client will use browser speechSynthesis
        res.status(503).json({ error: 'TTS unavailable', fallback: true });
      }
    });

    // Web UI (simple chat interface)
    this.app.get('/', (_req, res) => {
      res.send(WEB_UI_HTML);
    });

    // HTTP API: send a message to the agent
    this.app.post('/api/message', async (req, res) => {
      const { message } = req.body;
      if (!message) {
        res.status(400).json({ error: 'message is required' });
        return;
      }

      log.info('Received HTTP message', { length: message.length });
      try {
        const response = await this.agent.processMessage(message);
        res.json(response);
      } catch (err: any) {
        log.error('Error processing message', { error: err.message });
        res.status(500).json({ error: err.message });
      }
    });

    // Google Chat HTTP endpoint
    // Google Chat POSTs events here — responds synchronously (within 30s)
    this.app.post('/api/gchat/event', async (req, res) => {
      const event = req.body;
      log.info('Received Google Chat event', { type: event.type });

      try {
        if (event.type === 'ADDED_TO_SPACE') {
          res.json({ text: '✨ Alice is online! Send me a message and I\'ll get to work.' });
          return;
        }

        if (event.type === 'REMOVED_FROM_SPACE') {
          res.json({});
          return;
        }

        if (event.type === 'MESSAGE') {
          const userMessage = event.message?.argumentText?.trim() || event.message?.text?.trim() || '';
          if (!userMessage) {
            res.json({ text: 'I received an empty message.' });
            return;
          }

          // Process synchronously — respond directly with the agent's answer
          // Use a 25s timeout (Google Chat allows 30s)
          const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 25000));
          const agentPromise = this.agent.processMessage(userMessage);

          const result = await Promise.race([agentPromise, timeoutPromise]);

          if (result === null) {
            // Timed out — send a fallback
            res.json({ text: '⏳ Still working on it... (the request took longer than expected)' });
          } else {
            const toolInfo = result.toolsUsed.length > 0
              ? `\n\n_Tools: ${result.toolsUsed.join(', ')} | Iterations: ${result.iterations}_`
              : '';

            // Format for Google Chat
            const formatted = formatForGoogleChat(result.text) + toolInfo;
            res.json({ text: formatted });
          }
          return;
        }

        // Unknown event type
        res.json({});
      } catch (err: any) {
        log.error('Error handling Google Chat event', { error: err.message });
        res.json({ text: `❌ Error: ${err.message}` });
      }
    });

    // Clear conversation history
    this.app.post('/api/clear', (_req, res) => {
      this.agent.clearHistory();
      res.json({ status: 'history cleared', sessionId: this.agent.getSessionId() });
    });

    // List all sessions
    this.app.get('/api/sessions', (_req, res) => {
      const sessions = this.agent.listSessions();
      const currentId = this.agent.getSessionId();
      res.json({ sessions, currentId });
    });

    // Get user profile info (Google profile picture)
    let cachedUserInfo: any = null;
    this.app.get('/api/userinfo', async (_req, res) => {
      if (cachedUserInfo) return res.json(cachedUserInfo);
      try {
        const { getAccessToken } = await import('../utils/oauth.js');
        const token = await getAccessToken(
          this.config.googleChat.oauthClientId,
          this.config.googleChat.oauthClientSecret,
        );
        const resp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          cachedUserInfo = await resp.json();
          return res.json(cachedUserInfo);
        }
        res.json({ picture: null });
      } catch {
        res.json({ picture: null });
      }
    });

    // Get messages for a specific session
    this.app.get('/api/sessions/:id', (req, res) => {
      const messages = this.agent.getSessionMessages(req.params.id);
      res.json({
        messages: messages.map(m => {
          const text = m.parts.filter((p: any) => p.text).map((p: any) => p.text).join('');
          // Detect canvas messages by __canvas__ marker
          if (text.startsWith('__canvas__')) {
            try {
              const payload = JSON.parse(text.slice('__canvas__'.length));
              return { role: 'canvas', html: payload.html, title: payload.title };
            } catch { return { role: m.role, text }; }
          }
          return { role: m.role, text };
        }).filter((m: any) => m.role === 'canvas' || (m.text && m.text.trim()))
      });
    });

    // Create new session (same as clear)
    this.app.post('/api/sessions', (_req, res) => {
      this.agent.clearHistory();
      res.json({ sessionId: this.agent.getSessionId() });
    });

    // Switch to a session
    this.app.post('/api/sessions/:id/switch', (req, res) => {
      this.agent.switchSession(req.params.id);
      const messages = this.agent.getSessionMessages(req.params.id);
      res.json({
        sessionId: req.params.id,
        messages: messages.map(m => {
          const text = m.parts.filter((p: any) => p.text).map((p: any) => p.text).join('');
          if (text.startsWith('__canvas__')) {
            try {
              const payload = JSON.parse(text.slice('__canvas__'.length));
              return { role: 'canvas', html: payload.html, title: payload.title };
            } catch { return { role: m.role, text }; }
          }
          return { role: m.role, text };
        }).filter((m: any) => m.role === 'canvas' || (m.text && m.text.trim())),
      });
    });

    // Delete a session
    this.app.delete('/api/sessions/:id', (req, res) => {
      this.agent.deleteSession(req.params.id);
      res.json({ status: 'deleted', currentId: this.agent.getSessionId() });
    });

    // Export a session as markdown
    this.app.get('/api/sessions/:id/export', (req, res) => {
      try {
        const messages = this.agent.getSessionMessages(req.params.id);
        const sessions = this.agent.listSessions();
        const session = sessions.find((s: any) => s.id === req.params.id);
        const title = session?.title || 'Untitled';
        const date = session?.createdAt || new Date().toISOString();

        let md = `# ${title}\n\n*Exported: ${new Date().toLocaleString()}*\n*Created: ${date}*\n\n---\n\n`;
        for (const m of messages) {
          const role = m.role === 'user' ? '**You**' : '**Alice**';
          const text = m.parts?.map((p: any) => p.text || '').join('') || '';
          if (text.trim()) {
            md += `### ${role}\n\n${text.trim()}\n\n---\n\n`;
          }
        }

        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-zA-Z0-9]/g, '_')}.md"`);
        res.send(md);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Search API (keyword + semantic) ─────────────
    this.app.get('/api/search', async (req, res) => {
      try {
        const query = (req.query.q as string || '').trim();
        const type = (req.query.type as string) || 'keyword';
        const limit = parseInt(req.query.limit as string) || 10;

        if (!query) {
          res.status(400).json({ error: 'Query parameter "q" is required' });
          return;
        }

        if (type === 'semantic') {
          const apiKey = this.agent.getConfig().gemini.apiKey;
          if (!apiKey) {
            res.status(400).json({ error: 'Semantic search requires a Gemini API key' });
            return;
          }
          const results = await this.agent.getSessionStore().semanticSearch(query, apiKey, limit);
          res.json({ type: 'semantic', query, results });
        } else {
          const results = this.agent.getSessionStore().searchMessages(query, limit);
          res.json({ type: 'keyword', query, results });
        }
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Dashboard API ──────────────────────────────
    // List all tools
    this.app.get('/api/tools', async (_req, res) => {
      try {
        const { toGeminiFunctionDeclarations } = await import('../runtime/tools/registry.js');
        const tools = toGeminiFunctionDeclarations().map(t => ({
          name: t.name,
          description: t.description,
        }));
        res.json({ tools });
      } catch { res.json({ tools: [] }); }
    });

    // List memory files
    this.app.get('/api/memory', (_req, res) => {
      try {
        const store = getMemoryStore();
        const dir = resolve(this.config.memory.dir);

        if (store) {
          // DB-backed: return parsed items for memory/user, raw for others
          const files: any[] = [];

          // DB-backed files
          for (const file of ['memory', 'user'] as const) {
            const sections = store.getItemsByFile(file);
            files.push({
              name: file === 'user' ? 'USER' : 'MEMORY',
              type: 'items',
              sections: sections.map(s => ({
                heading: s.section,
                items: s.items.map(i => ({ id: i.id, content: i.content, createdAt: i.createdAt })),
              })),
            });
          }

          // Raw files
          for (const name of ['IDENTITY', 'SOUL', 'HEARTBEAT']) {
            const filePath = join(dir, `${name}.md`);
            files.push({
              name,
              type: 'raw',
              content: existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '',
            });
          }

          res.json({ files });
        } else {
          // Fallback: raw content for all files
          if (!existsSync(dir)) {
            res.json({ files: [] });
            return;
          }
          const files = readdirSync(dir)
            .filter((f: string) => f.endsWith('.md'))
            .map((f: string) => ({
              name: f.replace('.md', ''),
              type: 'raw',
              content: readFileSync(join(dir, f), 'utf-8'),
            }));
          res.json({ files });
        }
      } catch (err: any) {
        log.error('Failed to load memory files', { error: err.message });
        res.json({ files: [] });
      }
    });

    // Memory items CRUD (DB-backed)
    this.app.get('/api/memory/items', (req, res) => {
      try {
        const store = getMemoryStore();
        if (!store) {
          res.status(501).json({ error: 'Memory store not initialized' });
          return;
        }
        const file = req.query.file as string | undefined;
        const items = store.listItems(file);
        res.json({ items });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.post('/api/memory/items', (req, res) => {
      try {
        const store = getMemoryStore();
        if (!store) {
          res.status(501).json({ error: 'Memory store not initialized' });
          return;
        }
        const { file, section, content } = req.body;
        if (!file || !content) {
          res.status(400).json({ error: 'file and content are required' });
          return;
        }
        const id = store.addItem(file, section || '', content);
        store.syncToFile(resolve(this.config.memory.dir), file);
        this.agent.refreshContext();
        res.json({ status: 'added', id });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.put('/api/memory/items/:id', (req, res) => {
      try {
        const store = getMemoryStore();
        if (!store) {
          res.status(501).json({ error: 'Memory store not initialized' });
          return;
        }
        const id = parseInt(req.params.id, 10);
        const { content } = req.body;
        if (!content) {
          res.status(400).json({ error: 'content is required' });
          return;
        }
        const updated = store.updateItem(id, content);
        if (!updated) {
          res.status(404).json({ error: 'Item not found' });
          return;
        }
        // Sync both files since we don't know which one it belonged to
        store.syncToFile(resolve(this.config.memory.dir), 'memory');
        store.syncToFile(resolve(this.config.memory.dir), 'user');
        this.agent.refreshContext();
        res.json({ status: 'updated' });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.delete('/api/memory/items/:id', (req, res) => {
      try {
        const store = getMemoryStore();
        if (!store) {
          res.status(501).json({ error: 'Memory store not initialized' });
          return;
        }
        const id = parseInt(req.params.id, 10);
        const deleted = store.deleteItem(id);
        if (!deleted) {
          res.status(404).json({ error: 'Item not found' });
          return;
        }
        store.syncToFile(resolve(this.config.memory.dir), 'memory');
        store.syncToFile(resolve(this.config.memory.dir), 'user');
        this.agent.refreshContext();
        res.json({ status: 'deleted' });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    // Update a memory file (raw — for IDENTITY, SOUL, HEARTBEAT)
    this.app.put('/api/memory/:name', (req, res) => {
      try {
        const filePath = join(resolve(this.config.memory.dir), `${req.params.name}.md`);
        writeFileSync(filePath, req.body.content || '', 'utf-8');
        this.agent.refreshContext();
        res.json({ status: 'saved' });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    // List reminders
    this.app.get('/api/reminders', async (_req, res) => {
      try {
        const { scheduler } = await import('../scheduler/task-scheduler.js');
        const reminders = scheduler.listReminders();
        res.json({ reminders });
      } catch { res.json({ reminders: [] }); }
    });

    // Cancel a reminder
    this.app.delete('/api/reminders/:id', async (req, res) => {
      try {
        const { scheduler } = await import('../scheduler/task-scheduler.js');
        scheduler.cancelReminder(req.params.id);
        res.json({ status: 'cancelled' });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    // List available models
    this.app.get('/api/models', async (_req, res) => {
      try {
        const models = await this.agent.listAvailableModels();
        const active = { provider: this.agent.activeProvider, model: this.agent.activeModel };
        res.json({ models, active });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    // Switch model
    this.app.post('/api/models/switch', (req, res) => {
      try {
        const { provider, model } = req.body;
        if (!provider || !model) {
          return res.status(400).json({ error: 'provider and model required' });
        }
        this.agent.switchModel(provider, model);
        res.json({ status: 'switched', provider, model });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    // ── Mission Control API ──────────────────────────
    // Stats for Command Center
    this.app.get('/api/stats', async (_req, res) => {
      try {
        const stats = this.agent.getSessionStats();
        const sessions = this.agent.listSessions();
        const totalMessages = sessions.reduce((sum: number, s: any) => sum + (s.messageCount || 0), 0);
        res.json({
          uptime: Math.floor(process.uptime()),
          messagesTotal: totalMessages,
          sessionCount: sessions.length,
          apiCalls: stats.apiCalls,
          toolCalls: stats.toolCalls,
          toolsUsed: stats.toolsUsed,
          activeProvider: stats.activeProvider,
          activeModel: stats.activeModel,
          usingFallback: stats.usingFallback,
          sessionDuration: stats.sessionDuration,
        });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    // Connection status for Connections page
    this.app.get('/api/connections', async (_req, res) => {
      try {
        const connections: Array<{ name: string; status: 'online' | 'offline' | 'unknown'; detail: string }> = [];

        // Ollama
        try {
          const ollamaResp = await fetch(`http://${this.config.ollama.host}:${this.config.ollama.port}/api/tags`, {
            signal: AbortSignal.timeout(3000),
          });
          const ollamaData: any = await ollamaResp.json();
          const modelCount = ollamaData.models?.length || 0;
          connections.push({ name: 'Ollama (Local LLM)', status: 'online', detail: `${modelCount} model(s) available` });
        } catch {
          connections.push({ name: 'Ollama (Local LLM)', status: 'offline', detail: 'Not reachable' });
        }

        // Gemini
        const hasGeminiKey = !!this.config.gemini.apiKey;
        connections.push({
          name: 'Gemini API',
          status: hasGeminiKey ? 'online' : 'offline',
          detail: hasGeminiKey ? `Model: ${this.config.gemini.model}` : 'No API key configured',
        });

        // Google Chat
        const hasGchat = !!this.config.googleChat.sheetId;
        connections.push({
          name: 'Google Chat',
          status: hasGchat ? 'online' : 'offline',
          detail: hasGchat ? 'Relay active' : 'Not configured',
        });

        // OpenRouter
        const hasOpenRouter = !!this.config.openRouter.apiKey;
        connections.push({
          name: 'OpenRouter',
          status: hasOpenRouter ? 'online' : 'offline',
          detail: hasOpenRouter ? 'API key configured' : 'Not configured',
        });

        // MCP Servers
        if (this.config.mcp.servers.length > 0) {
          for (const srv of this.config.mcp.servers) {
            connections.push({
              name: `MCP: ${srv.name}`,
              status: srv.enabled !== false ? 'online' : 'offline',
              detail: srv.enabled !== false ? `Running: ${srv.command}` : 'Disabled',
            });
          }
        }

        res.json({ connections });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    // Settings — read/write SOUL.md and IDENTITY.md
    this.app.get('/api/settings', (_req, res) => {
      try {
        const dir = resolve(this.config.memory.dir);
        const soulPath = join(dir, 'SOUL.md');
        const identityPath = join(dir, 'IDENTITY.md');
        const soul = existsSync(soulPath) ? readFileSync(soulPath, 'utf-8') : '';
        const identity = existsSync(identityPath) ? readFileSync(identityPath, 'utf-8') : '';
        res.json({
          soul,
          identity,
          config: {
            provider: this.agent.activeProvider,
            model: this.agent.activeModel,
            memoryDir: this.config.memory.dir,
            gatewayPort: this.config.gateway.port,
            heartbeatEnabled: this.config.heartbeat.enabled,
            heartbeatInterval: this.config.heartbeat.intervalMinutes,
          },
        });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.put('/api/settings/soul', (req, res) => {
      try {
        const filePath = join(resolve(this.config.memory.dir), 'SOUL.md');
        writeFileSync(filePath, req.body.content || '', 'utf-8');
        this.agent.refreshContext();
        res.json({ status: 'saved' });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.put('/api/settings/identity', (req, res) => {
      try {
        const filePath = join(resolve(this.config.memory.dir), 'IDENTITY.md');
        writeFileSync(filePath, req.body.content || '', 'utf-8');
        this.agent.refreshContext();
        res.json({ status: 'saved' });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    // ── Persona API ───────────────────────────────
    this.app.get('/api/personas', (_req, res) => {
      try {
        const personas = this.agent.getSessionStore().listPersonas();
        res.json({ personas });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.post('/api/personas', (req, res) => {
      try {
        const { name, description, soul, identity } = req.body;
        if (!name) return res.status(400).json({ error: 'name is required' });
        const id = this.agent.getSessionStore().createPersona(
          name, description || '', soul || '', identity || ''
        );
        res.json({ id, status: 'created' });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.put('/api/personas/:id', (req, res) => {
      try {
        const updates: any = {};
        if (req.body.name !== undefined) updates.name = req.body.name;
        if (req.body.description !== undefined) updates.description = req.body.description;
        if (req.body.soul !== undefined) updates.soulContent = req.body.soul;
        if (req.body.identity !== undefined) updates.identityContent = req.body.identity;
        this.agent.getSessionStore().updatePersona(req.params.id, updates);
        res.json({ status: 'updated' });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.delete('/api/personas/:id', (req, res) => {
      try {
        const ok = this.agent.getSessionStore().deletePersona(req.params.id);
        if (!ok) return res.status(400).json({ error: 'Cannot delete default persona' });
        res.json({ status: 'deleted' });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.post('/api/personas/:id/activate', (req, res) => {
      try {
        this.agent.getSessionStore().setActivePersona(req.params.id);
        this.agent.refreshContext();  // Rebuild system prompt with new persona
        res.json({ status: 'activated' });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    // ── Knowledge Graph API ─────────────────────────
    this.app.get('/api/knowledge-graph', (_req, res) => {
      try {
        const store = getMemoryStore();
        if (!store) { res.json({ entities: [] }); return; }

        const query = _req.query.q as string | undefined;
        const entities = query
          ? store.searchEntities(query)
          : store.listEntities();

        const enriched = entities.map((e: any) => ({
          ...e,
          relations: store.getRelations(e.name),
        }));

        res.json({ entities: enriched });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Cron Jobs API ─────────────────────────────
    this.app.get('/api/cron-jobs', (_req, res) => {
      try {
        const jobs = this.cronJobs.listJobs();
        res.json({ jobs });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.post('/api/cron-jobs', (req, res) => {
      try {
        const { name, cronExpr, prompt, isolated } = req.body;
        if (!name || !cronExpr || !prompt) {
          return res.status(400).json({ error: 'name, cronExpr, and prompt are required' });
        }
        const job = this.cronJobs.addJob({
          id: `job_${Date.now().toString(36)}`,
          name,
          cronExpr,
          prompt,
          isolated: isolated !== false,
          enabled: true,
        });
        res.json({ job });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.delete('/api/cron-jobs/:id', (req, res) => {
      try {
        const removed = this.cronJobs.removeJob(req.params.id);
        if (!removed) return res.status(404).json({ error: 'Job not found' });
        res.json({ status: 'deleted' });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.post('/api/cron-jobs/:id/run', async (req, res) => {
      try {
        const result = await this.cronJobs.runJob(req.params.id);
        res.json({ status: 'completed', result: result.slice(0, 2000) });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.post('/api/cron-jobs/:id/toggle', (req, res) => {
      try {
        const job = this.cronJobs.getJob(req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.enabled) {
          this.cronJobs.pauseJob(req.params.id);
          res.json({ status: 'paused' });
        } else {
          this.cronJobs.resumeJob(req.params.id);
          res.json({ status: 'resumed' });
        }
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });

    this.app.put('/api/cron-jobs/:id', (req, res) => {
      try {
        const job = this.cronJobs.getJob(req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        // Remove and re-add with updated fields
        this.cronJobs.removeJob(req.params.id);
        const updated = this.cronJobs.addJob({
          id: req.params.id,
          name: req.body.name || job.name,
          cronExpr: req.body.cronExpr || job.cronExpr,
          prompt: req.body.prompt || job.prompt,
          isolated: req.body.isolated !== undefined ? req.body.isolated : job.isolated,
          enabled: req.body.enabled !== undefined ? req.body.enabled : job.enabled,
        });
        res.json({ job: updated });
      } catch (err: any) { res.status(500).json({ error: err.message }); }
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      log.info('WebSocket client connected');

      // Subscribe this client to real-time tool output events
      const onToolOutput = (data: { tool: string; stream: string; chunk: string; command: string }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'tool_output', ...data }));
        }
      };
      toolEvents.on('tool_output', onToolOutput);

      // Smart notification forwarding
      const onNotification = (data: { message: string; priority: string; category: string; timestamp: number }) => {
        // Send to WebSocket client as a toast
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'notification', ...data }));
        }
        // For warning/urgent: also send to Google Chat
        if ((data.priority === 'warning' || data.priority === 'urgent') && this.chat) {
          this.chat.sendMessage(`🔔 **[${data.priority.toUpperCase()}]** ${data.message}`).catch(() => { });
        }
      };
      toolEvents.on('notification', onNotification);
      // Per-connection message queue
      let processing = false;
      const queue: Array<{ text: string; attachments: Array<{ name: string; type: string; data: string }> }> = [];

      const processMessage = async (text: string, attachments: Array<{ name: string; type: string; data: string }>) => {
        // --- Chat command handling ---
        const trimmed = text.trim().toLowerCase();
        if (trimmed.startsWith('/')) {
          const cmdResult = await this.handleChatCommand(trimmed);
          if (cmdResult !== null) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'done', text: cmdResult, toolsUsed: [], iterations: 0 }));
            }
            return;
          }
        }

        try {
          // Send typing indicator before processing
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'typing' }));
          }

          const response = await this.agent.processMessageStream(
            text,
            (token: string) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'token', text: token }));
              }
              // Check if agent is waiting for location
              if (this.agent.hasLocationRequest() && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'location_request' }));
              }
              // Check for canvas during streaming (tool may push mid-conversation)
              const midCanvas = this.agent.getLastCanvas();
              if (midCanvas && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'canvas', html: midCanvas.html, title: midCanvas.title }));
                this.agent.clearCanvas();
              }
            },
            attachments,
            // Activity events — forwarded to client for the console panel
            (action: string, detail?: string) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'activity', action, detail }));
              }
            }
          );

          // Check for canvas content after processing
          const canvas = this.agent.getLastCanvas?.();
          if (canvas && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'canvas', html: canvas.html, title: canvas.title }));
            this.agent.clearCanvas?.();
          }

          // Send final done message with metadata
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'done',
              text: response.text,
              toolsUsed: response.toolsUsed,
              iterations: response.iterations,
            }));
          }
        } catch (err: any) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'done', error: err.message }));
          }
        }
      };

      const drainQueue = async () => {
        while (queue.length > 0 && ws.readyState === WebSocket.OPEN) {
          const next = queue.shift()!;
          await processMessage(next.text, next.attachments);
        }
        processing = false;
      };

      ws.on('message', async (data: Buffer) => {
        const raw = data.toString();
        log.debug('WebSocket message received', { length: raw.length });

        // Parse JSON payload (or plain text for backward compat)
        let text = raw;
        let attachments: Array<{ name: string; type: string; data: string }> = [];
        try {
          const parsed = JSON.parse(raw);
          if (parsed.text !== undefined) {
            text = parsed.text;
            attachments = parsed.attachments || [];
          }
          // Handle location response from client
          if (parsed.type === 'location') {
            this.agent.resolveLocation?.(parsed.lat, parsed.lng, parsed.accuracy);
            return;
          }
          if (parsed.type === 'location_error') {
            this.agent.resolveLocation?.(null, null, null, parsed.error);
            return;
          }

          // ── Voice Mode handlers (Gemini Live API) ──
          if (parsed.type === 'voice_start') {
            // Initialize transcript accumulators
            (ws as any)._voiceInputTranscript = '';
            (ws as any)._voiceOutputTranscript = '';
            try {
              const apiKey = this.config.gemini?.apiKey || process.env.GEMINI_API_KEY || '';
              const liveAi = new GoogleGenAI({ apiKey });
              const liveModel = process.env.VOICE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';

              // Use Alice's full system prompt (includes user memories, persona, etc.)
              // with a voice-specific overlay for conversational style
              const basePrompt = this.agent.getSystemPrompt();
              const sysPrompt = basePrompt + '\n\nIMPORTANT: This is a live voice conversation. Keep responses natural, conversational, and concise. Avoid markdown formatting, code blocks, or long lists. Respond as if speaking to a friend.';

              // Select voice-appropriate tools (skip file writing, code, heavy tools)
              const voiceToolNames = new Set([
                'web_search', 'search_memory', 'semantic_search', 'set_reminder',
                'cancel_reminder', 'list_reminders', 'get_location', 'web_fetch',
                'bash', 'read_file', 'list_directory', 'git_status',
                'create_cron_job', 'list_cron_jobs', 'delete_cron_job',
              ]);
              const { getAllTools } = await import('../runtime/tools/registry.js');
              const voiceTools = getAllTools()
                .filter(t => voiceToolNames.has(t.name) || t.name.startsWith('mcp_'))
                .map(t => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                }));

              const liveSession = await liveAi.live.connect({
                model: liveModel,
                config: {
                  responseModalities: [Modality.AUDIO],
                  systemInstruction: sysPrompt,
                  inputAudioTranscription: {},
                  outputAudioTranscription: {},
                  tools: [{ functionDeclarations: voiceTools }],
                },
                callbacks: {
                  onopen: () => {
                    log.info('Gemini Live session opened');
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'voice_ready' }));
                    }
                  },
                  onmessage: (message: LiveServerMessage) => {
                    if (ws.readyState !== WebSocket.OPEN) return;

                    // Handle interruption
                    if (message.serverContent && (message.serverContent as any).interrupted) {
                      ws.send(JSON.stringify({ type: 'voice_interrupted' }));
                      return;
                    }

                    // Handle audio output
                    if (message.serverContent?.modelTurn?.parts) {
                      for (const part of message.serverContent.modelTurn.parts) {
                        if ((part as any).inlineData?.data) {
                          ws.send(JSON.stringify({
                            type: 'voice_audio_chunk',
                            audio: (part as any).inlineData.data,
                          }));
                        }
                      }
                    }

                    // Handle turn completion
                    if (message.serverContent?.modelTurn === undefined && message.serverContent && !(message.serverContent as any).interrupted) {
                      ws.send(JSON.stringify({ type: 'voice_turn_complete' }));
                    }

                    // Handle input transcription
                    if ((message as any).serverContent?.inputTranscription?.text) {
                      const txt = (message as any).serverContent.inputTranscription.text;
                      (ws as any)._voiceInputTranscript += txt;
                      ws.send(JSON.stringify({
                        type: 'voice_input_transcript',
                        text: txt,
                      }));
                    }

                    // Handle output transcription
                    if ((message as any).serverContent?.outputTranscription?.text) {
                      const txt = (message as any).serverContent.outputTranscription.text;
                      (ws as any)._voiceOutputTranscript += txt;
                      ws.send(JSON.stringify({
                        type: 'voice_output_transcript',
                        text: txt,
                      }));
                    }

                    // Handle tool calls — execute and return results
                    if (message.toolCall?.functionCalls) {
                      ws.send(JSON.stringify({
                        type: 'voice_status',
                        status: 'thinking',
                      }));

                      // Async IIFE — onmessage is sync but tool execution is async
                      (async () => {
                        const { executeTool } = await import('../runtime/tools/registry.js');
                        const session = (ws as any)._liveSession as LiveSession | undefined;
                        if (!session) return;

                        const functionResponses: Array<{ name: string; id: string; response: Record<string, any> }> = [];
                        for (const fc of message.toolCall!.functionCalls!) {
                          const toolName = fc.name || 'unknown';
                          log.info('Voice tool call', { name: toolName, args: Object.keys(fc.args || {}) });
                          ws.send(JSON.stringify({
                            type: 'voice_tool_call',
                            tool: toolName,
                          }));

                          try {
                            const result = await executeTool(toolName, fc.args || {});
                            functionResponses.push({
                              name: toolName,
                              id: fc.id || '',
                              response: { result },
                            });
                          } catch (err: any) {
                            functionResponses.push({
                              name: toolName,
                              id: fc.id || '',
                              response: { error: err.message || 'Tool execution failed' },
                            });
                          }
                        }

                        // Send tool results back to Gemini Live
                        session.sendToolResponse({ functionResponses });
                      })().catch(err => {
                        log.error('Voice tool execution failed', { error: err.message });
                      });
                    }
                  },
                  onerror: (e: any) => {
                    log.error('Gemini Live session error', { error: e?.message || String(e) });
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'voice_error', error: 'Live session error: ' + (e?.message || 'unknown') }));
                    }
                  },
                  onclose: (e: any) => {
                    log.info('Gemini Live session closed', { reason: e?.reason || 'unknown' });
                    // Only send session_closed if we had a successful connection
                    // (onopen would have fired first)
                  },
                },
              });

              // Store session on the WebSocket for audio chunk forwarding
              (ws as any)._liveSession = liveSession;
            } catch (err: any) {
              log.error('Failed to start Gemini Live session', { error: err.message });
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'voice_error', error: 'Failed to connect to Gemini Live: ' + err.message }));
              }
            }
            return;
          }

          if (parsed.type === 'voice_audio_in' && parsed.audio) {
            // Forward PCM audio chunk to Gemini Live session
            const session = (ws as any)._liveSession as LiveSession | undefined;
            if (session) {
              try {
                session.sendRealtimeInput({
                  audio: {
                    data: parsed.audio,
                    mimeType: 'audio/pcm;rate=16000',
                  },
                });
              } catch (e: any) {
                log.warn('Failed to send audio to Live session', { error: e.message });
              }
            }
            return;
          }

          // Forward screen share video frames to Gemini Live session
          if (parsed.type === 'voice_video_frame' && parsed.frame) {
            const session = (ws as any)._liveSession as LiveSession | undefined;
            if (session) {
              try {
                session.sendRealtimeInput({
                  media: {
                    data: parsed.frame,
                    mimeType: 'image/jpeg',
                  },
                });
              } catch (e: any) {
                log.warn('Failed to send video frame to Live session', { error: e.message });
              }
            }
            return;
          }

          if (parsed.type === 'voice_stop') {
            // Save accumulated transcripts to session store
            const inputTranscript = (ws as any)._voiceInputTranscript || '';
            const outputTranscript = (ws as any)._voiceOutputTranscript || '';
            this.agent.saveVoiceTranscript(inputTranscript, outputTranscript);
            (ws as any)._voiceInputTranscript = '';
            (ws as any)._voiceOutputTranscript = '';

            const session = (ws as any)._liveSession as LiveSession | undefined;
            if (session) {
              try { session.close(); } catch { }
              (ws as any)._liveSession = null;
            }
            return;
          }
        } catch {
          // Plain text message — no attachments
        }

        // If already processing, queue the message
        if (processing) {
          queue.push({ text, attachments });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'queued', position: queue.length }));
          }
          log.debug('Message queued', { position: queue.length });
          return;
        }

        processing = true;
        await processMessage(text, attachments);
        await drainQueue();
      });

      ws.on('close', () => {
        log.info('WebSocket client disconnected');
        toolEvents.off('tool_output', onToolOutput);
        toolEvents.off('notification', onNotification);
        queue.length = 0;
        // Clean up any active Gemini Live session
        const liveSession = (ws as any)._liveSession;
        if (liveSession) {
          try { liveSession.close(); } catch { }
          (ws as any)._liveSession = null;
        }
      });
    });
  }

  /**
   * Handle chat commands (messages starting with /).
   * Returns response string if handled, null if not a recognized command.
   */
  private async handleChatCommand(command: string): Promise<string | null> {
    const cmd = command.split(/\s+/)[0];

    switch (cmd) {
      case '/status': {
        const s = this.agent.getStatus();
        const lines = [
          '📊 **Session Status**',
          `• Session: \`${s.sessionId.slice(0, 8)}...\``,
          `• Messages: ${s.messageCount}`,
          `• Model: ${s.model}` + (s.fallbackModel ? ` (fallback: ${s.fallbackModel})` : ''),
          `• System prompt: ${s.systemPromptChars} chars`,
          `• Est. context: ~${s.estimatedTokens} tokens`,
        ];
        if (s.lastUsage) {
          lines.push(`• Last request: ${s.lastUsage.promptTokens} prompt + ${s.lastUsage.completionTokens} completion = ${s.lastUsage.totalTokens} tokens`);
        }
        return lines.join('\n');
      }

      case '/new':
      case '/reset': {
        this.agent.clearHistory();
        this.agent.refreshContext();
        return '🔄 Session reset. Fresh start!';
      }

      case '/compact': {
        return await this.agent.compactSession();
      }

      case '/stats': {
        const stats = this.agent.getSessionStats();
        const durationMin = Math.round(stats.sessionDuration / 60000);
        const lines = [
          '📈 **Session Usage**',
          `• Duration: ${durationMin} min`,
          `• API calls: ${stats.apiCalls}`,
          `• Tool calls: ${stats.toolCalls}`,
          `• Provider: ${stats.activeProvider}` + (stats.usingFallback ? ' *(failover)*' : ''),
          `• Model: ${stats.activeModel}`,
        ];
        const toolEntries = Object.entries(stats.toolsUsed).sort((a, b) => b[1] - a[1]);
        if (toolEntries.length > 0) {
          lines.push('', '**Tool Usage:**');
          for (const [name, count] of toolEntries.slice(0, 10)) {
            lines.push(`• \`${name}\`: ${count}`);
          }
        }
        return lines.join('\n');
      }

      case '/help': {
        return [
          '**Available Commands:**',
          '• `/status` — Session info (model, tokens, messages)',
          '• `/stats` — Usage patterns (API calls, tools, duration)',
          '• `/new` or `/reset` — Start a fresh session',
          '• `/compact` — Summarize conversation to free context space',
          '• `/help` — Show this help',
        ].join('\n');
      }

      default:
        return null; // Not a recognized command — pass to agent
    }
  }

  /**
   * Start the gateway server.
   */
  async start(): Promise<void> {
    const { host, port } = this.config.gateway;

    return new Promise((resolve) => {
      this.server.listen(port, host, async () => {
        log.info(`🚀 Alice Gateway running at http://${host}:${port}`);
        log.info(`📡 WebSocket at ws://${host}:${port}`);
        log.info(`🌐 Web UI at http://${host}:${port}/`);

        // Print phone-friendly mDNS URL
        try {
          const localName = hostname().replace(/\.local$/, '');
          log.info(`📱 Phone access: http://${localName}.local:${port}/`);
        } catch (_) { /* ignore */ }

        // Start listening for Google Chat messages via Pub/Sub
        await this.chat.startListening();

        // Start heartbeat if enabled
        if (this.config.heartbeat.enabled) {
          startHeartbeat(this.config, this.agent, this.chat);
        }

        // Start cron job schedules (after MCP servers have had time to connect)
        // Delay slightly to ensure MCP tools are registered
        setTimeout(() => {
          this.cronJobs.startAll();
          log.info('📅 Cron job scheduler started');

          // Start meeting auto-prep and email watcher
          startMeetingPrep(this.agent, this.chat);
          log.info('📋 Meeting auto-prep started');

          startEmailWatcher(this.agent, this.chat);
          log.info('📧 Email watcher started');
        }, 5000);

        // Auto-backup: commit and push to GitHub every 6 hours
        try {
          scheduler.addReminder('auto-backup', '0 */6 * * *');
          // Override the reminder callback to run git_backup instead
          const { executeTool } = await import('../runtime/tools/registry.js');
          const originalCallback = scheduler['notifyCallback'];
          scheduler.setNotifyCallback(async (msg: string) => {
            if (msg.includes('auto-backup')) {
              log.info('Running scheduled auto-backup...');
              const result = await executeTool('git_backup', {});
              log.info('Auto-backup result', { result: result.slice(0, 200) });
            } else if (originalCallback) {
              originalCallback(msg);
            }
          });
          log.info('🔄 Auto-backup scheduled every 6 hours');
        } catch (err: any) {
          log.warn('Auto-backup scheduling failed', { error: err.message });
        }

        // Start file watcher for live workspace awareness
        const ragIndex = this.agent.getRagIndex();
        if (ragIndex) {
          this.fileWatcher = new FileWatcher(ragIndex, process.cwd());
          this.fileWatcher.start();
          log.info('👁️ File watcher started for live workspace awareness');
        }

        resolve();
      });
    });
  }

  /**
   * Stop the gateway server.
   */
  async stop(): Promise<void> {
    stopHeartbeat();
    stopMeetingPrep();
    stopEmailWatcher();
    this.cronJobs.stopAll();
    if (this.fileWatcher) this.fileWatcher.stop();
    this.server.close();
    log.info('Gateway stopped');
  }

  getAgent(): Agent {
    return this.agent;
  }

  getChat(): GoogleChatAdapter {
    return this.chat;
  }
}

// ============================================================
// Built-in Web UI — Gemini-style Design
// ============================================================

const WEB_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">
  <title>Alice</title>
  <meta name="description" content="Alice — Personal AI Assistant">
  <meta name="theme-color" content="#131314">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Alice">
  <link rel="icon" type="image/png" href="/alice-icon-512.png">
  <link rel="apple-touch-icon" href="/alice-icon-512.png">
  <link rel="manifest" href="/manifest.json">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Google+Sans+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/marked-highlight@2.1.1/lib/index.umd.min.js"><\/script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><\/script>
  <style>
    html {
      height: 100%;
      height: -webkit-fill-available;
    }
    :root {
      /* ── M3 Dark Theme — Purple Primary ── */
      --bg-primary: #131314;          /* surface */
      --bg-secondary: #1b1b1f;        /* surface-container-low */
      --bg-tertiary: #211f26;         /* surface-container */
      --surface: #2b2930;             /* surface-container-high */
      --surface-hover: #36343b;       /* surface-container-highest */
      --border: #49454f;              /* outline-variant */
      --border-subtle: #322f35;       /* surface-variant */
      --text-primary: #e6e0e9;        /* on-surface */
      --text-secondary: #cac4d0;      /* on-surface-variant */
      --text-tertiary: #938f99;       /* outline */
      --accent: #cfbcff;              /* primary (tone 80) */
      --accent-dim: rgba(207,188,255,0.08);  /* primary-container */
      --accent-glow: rgba(207,188,255,0.12); /* state-layer: focus */
      --user-bg: #7c3aed;             /* vibrant purple from icon */
      --user-text: #eaddff;           /* on-primary-container */
      --success: #a8dab5;             /* tertiary (green tone 80) */
      --error: #f2b8b5;               /* error (tone 80) */
      /* ── M3 Shape Scale ── */
      --shape-xs: 4px;                /* extra-small: badges, chips */
      --shape-sm: 8px;                /* small: cards, list items */
      --shape-md: 12px;               /* medium: dialogs, menus */
      --shape-lg: 16px;               /* large: FABs, sheets */
      --shape-xl: 28px;               /* extra-large: containers */
      /* ── Layout ── */
      --radius: 20px;
      --radius-sm: 12px;
      --max-width: 768px;
      /* ── Typography ── */
      --font: 'Google Sans', 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'Google Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace;
      /* ── M3 Motion ── */
      --motion-standard: cubic-bezier(0.2, 0, 0, 1);
      --motion-emphasized: cubic-bezier(0.2, 0, 0, 1);
      --motion-decelerate: cubic-bezier(0, 0, 0, 1);
      --motion-accelerate: cubic-bezier(0.3, 0, 1, 1);
      --duration-short: 200ms;
      --duration-medium: 300ms;
      --duration-long: 500ms;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }

    body {
      font-family: var(--font);
      background: var(--bg-primary);
      color: var(--text-primary);
      display: flex;
      overflow: hidden;
      height: 100dvh;
      height: -webkit-fill-available;
    }

    /* ── Sidebar ─────────────────────── */
    .sidebar {
      width: 280px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      transition: margin-left var(--duration-medium) var(--motion-emphasized), opacity var(--duration-short) var(--motion-standard);
      overflow: hidden;
      z-index: 20;
    }
    .sidebar.collapsed {
      margin-left: -280px;
      opacity: 0;
    }
    .sidebar-header {
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }
    .sidebar-new-chat {
      flex: 1;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-primary);
      border-radius: 20px;
      padding: 8px 16px;
      font-size: 13px;
      font-family: var(--font);
      cursor: pointer;
      transition: all var(--duration-short) var(--motion-standard);
      text-align: left;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sidebar-new-chat:hover {
      background: var(--surface-hover);
      border-color: var(--accent);
    }
    .sidebar-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
    }
    .sidebar-list::-webkit-scrollbar { width: 4px; }
    .sidebar-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
    .sidebar-group-label {
      font-size: 11px;
      color: var(--text-tertiary);
      padding: 8px 16px 4px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .sidebar-item {
      display: flex;
      align-items: center;
      padding: 8px 16px;
      cursor: pointer;
      transition: background var(--duration-short) var(--motion-standard);
      border-radius: 0 20px 20px 0;
      margin-right: 8px;
      position: relative;
      gap: 12px;
    }
    .sidebar-item svg {
      flex-shrink: 0;
      color: var(--text-secondary);
    }
    .sidebar-item:hover {
      background: var(--surface-hover);
    }
    .sidebar-item.active {
      background: var(--accent-dim);
    }
    .sidebar-item.active .sidebar-item-title {
      color: var(--accent);
    }
    .sidebar-item-title {
      flex: 1;
      font-size: 13px;
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.4;
    }
    .sidebar-item-delete {
      opacity: 0;
      background: transparent;
      border: none;
      color: var(--text-tertiary);
      cursor: pointer;
      font-size: 14px;
      padding: 4px 8px;
      border-radius: 4px;
      transition: all var(--duration-short) var(--motion-standard);
      flex-shrink: 0;
    }
    .sidebar-item:hover .sidebar-item-delete {
      opacity: 1;
    }
    .sidebar-item-delete:hover {
      color: var(--error);
      background: rgba(242, 139, 130, 0.1);
    }
    .sidebar-overlay {
      display: none;
    }
    @media (max-width: 768px) {
      .sidebar { position: fixed; left: 0; top: 0; bottom: 0; z-index: 30; }
      .sidebar.collapsed { margin-left: -280px; }
      .sidebar-overlay {
        display: none;
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.5);
        z-index: 25;
      }
      .sidebar-overlay.active { display: block; }
      .msg-content {
        font-size: 13px;
        line-height: 1.45;
      }
      .msg-content h1 { font-size: 1.15em; }
      .msg-content h2 { font-size: 1.05em; }
      .msg-content h3 { font-size: 1em; }
      .msg-content p { margin-bottom: 8px; }
      .msg-content ul, .msg-content ol { margin: 0 0 16px 16px; }
      .msg-content li { margin-bottom: 2px; }
      .msg-row.user .msg-content {
        max-width: 80%;
        padding: 8px 16px;
      }
      .header-btn { padding: 0; width: 40px; height: 40px; border-radius: 50%; font-size: 18px; display: flex; align-items: center; justify-content: center; }
      .header-btn .btn-label { display: none; }
      .header-actions { flex-shrink: 0; }
    }

    /* ── Main Content ────────────────── */
    .main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      position: relative;
    }

    /* ── Header ─────────────────────── */
    header {
      padding: calc(8px + env(safe-area-inset-top, 0px)) 16px 8px 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
      background: var(--bg-primary);
      z-index: 10;
    }
    .menu-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      width: 40px; height: 40px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      transition: background var(--duration-short) var(--motion-standard);
      flex-shrink: 0;
    }
    .menu-btn:hover { background: rgba(207,188,255,0.08); }
    .menu-btn svg { width: 22px; height: 22px; }
    .logo {
      width: 32px; height: 32px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .logo svg { width: 32px; height: 32px; }
    .welcome-icon svg { width: 64px; height: 64px; }
    header h1 {
      font-size: 18px;
      font-weight: 500;
      color: var(--text-primary);
      letter-spacing: 0.3px;
    }
    .status-badge {
      font-size: 11px;
      color: var(--success);
      background: rgba(129, 201, 149, 0.1);
      padding: 4px 8px;
      border-radius: 12px;
      font-weight: 500;
      display: flex; align-items: center; gap: 4px;
    }
    .status-dot {
      width: 6px; height: 6px;
      background: var(--success);
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .header-spacer { flex: 1; }
    .header-actions {
      display: flex; gap: 8px;
    }
    .header-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 8px 16px;
      white-space: nowrap;
      border-radius: 20px;
      font-size: 13px;
      font-family: var(--font);
      cursor: pointer;
      transition: all 0.2s;
    }
    .header-btn:hover {
      background: var(--surface-hover);
      color: var(--text-primary);
    }

    /* ── Messages Area ──────────────── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 24px 16px 120px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      scroll-behavior: smooth;
    }
    #messages::-webkit-scrollbar { width: 6px; }
    #messages::-webkit-scrollbar-track { background: transparent; }
    #messages::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 3px;
    }

    /* ── Message Rows ───────────────── */
    .msg-row {
      display: flex;
      gap: 8px;
      max-width: var(--max-width);
      width: 100%;
      margin: 0 auto;
      animation: fadeIn var(--duration-medium) var(--motion-decelerate);
      min-width: 0;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .msg-row.user { justify-content: flex-end; }
    .msg-row.agent { justify-content: flex-start; }

    .avatar {
      width: 32px; height: 32px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
      margin-top: 0;
    }
    .avatar.alice {
      background: transparent;
      overflow: hidden;
    }
    .avatar.alice img {
      width: 100%; height: 100%;
      object-fit: cover;
      border-radius: 50%;
    }
    .avatar.user-av {
      background: var(--user-bg);
      color: var(--user-text);
      font-weight: 500;
      font-size: 13px;
      overflow: hidden;
    }
    .avatar.user-av img {
      width: 100%; height: 100%;
      object-fit: cover;
      border-radius: 50%;
    }

    .msg-content {
      font-size: 15px;
      line-height: 1.6;
      word-wrap: break-word;
      overflow-wrap: anywhere;
      max-width: calc(var(--max-width) - 50px);
      min-width: 0;
      overflow: hidden;
    }
    .msg-row.user .msg-content {
      background: var(--user-bg);
      color: var(--user-text);
      padding: 8px 16px;
      border-radius: var(--shape-xl) var(--shape-xl) var(--shape-xs) var(--shape-xl);
      max-width: 65%;
    }
    .msg-row.agent .msg-content {
      padding: 4px 0;
    }

    /* ── Thinking Indicator ─────────── */
    .thinking {
      display: flex; gap: 4px; align-items: center;
      padding: 16px 4px; min-height: 32px;
    }
    .thinking .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--accent);
      animation: bounce 1.4s infinite ease-in-out;
    }
    .thinking .dot:nth-child(2) { animation-delay: 0.16s; }
    .thinking .dot:nth-child(3) { animation-delay: 0.32s; }
    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
      40% { transform: scale(1); opacity: 1; }
    }

    /* ── Markdown Typography ────────── */
    .msg-content h1, .msg-content h2, .msg-content h3 {
      margin: 16px 0 8px;
      color: var(--accent);
      font-weight: 500;
    }
    .msg-content h1 { font-size: 1.4em; }
    .msg-content h2 { font-size: 1.2em; }
    .msg-content h3 { font-size: 1.05em; }
    .msg-content p { margin-bottom: 16px; }
    .msg-content ul, .msg-content ol { margin: 0 0 16px 24px; }
    .msg-content li { margin-bottom: 4px; }
    .msg-content strong { color: var(--text-primary); }
    .msg-content a { color: var(--accent); text-decoration: none; }
    .msg-content a:hover { text-decoration: underline; }
    .msg-content img {
      max-width: 100%;
      height: auto;
      max-height: 400px;
      border-radius: var(--shape-lg);
      margin: 8px 0;
      display: block;
      cursor: pointer;
      transition: transform var(--duration-short) var(--motion-decelerate);
    }
    .msg-content img:hover {
      transform: scale(1.02);
    }
    .msg-content hr { border: none; border-top: 1px solid var(--border-subtle); margin: 16px 0; }

    /* ── Inline Code ────────────────── */
    .msg-content code {
      font-family: var(--font-mono);
      background: var(--bg-tertiary);
      padding: 2px 6px;
      border-radius: var(--shape-sm);
      font-size: 13px;
      color: #d2a8ff;
    }

    /* ── Code Blocks ────────────────── */
    .msg-content pre {
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      overflow: hidden;
      margin: 12px 0;
      border: 1px solid var(--border-subtle);
      max-width: 100%;
    }
    .msg-content pre code {
      background: transparent;
      padding: 16px;
      display: block;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-primary);
      overflow-x: auto;
      white-space: pre;
      word-break: normal;
    }
    /* ── Tables ─────────────────────── */
    .msg-content table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 14px;
      display: block;
      overflow-x: auto;
    }
    .msg-content th, .msg-content td {
      padding: 8px 12px;
      border: 1px solid var(--border-subtle);
      text-align: left;
      white-space: nowrap;
    }
    .msg-content th {
      background: var(--bg-tertiary);
      font-weight: 500;
    }
    .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border-subtle);
      font-size: 12px;
    }
    .code-lang {
      color: var(--text-tertiary);
      font-family: var(--font);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .copy-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 12px;
      font-family: var(--font);
      padding: 4px 8px;
      border-radius: var(--shape-sm);
      transition: all 0.15s;
      display: flex; align-items: center; gap: 4px;
    }
    .copy-btn:hover { background: var(--surface-hover); color: var(--text-primary); }
    .copy-btn.copied { color: var(--success); }

    /* ── Tables ──────────────────────── */
    .msg-content table {
      border-collapse: collapse;
      width: 100%;
      margin: 16px 0;
      font-size: 14px;
    }
    .msg-content th, .msg-content td {
      border: 1px solid var(--border-subtle);
      padding: 8px 16px;
      text-align: left;
    }
    .msg-content th { background: var(--bg-tertiary); color: var(--accent); font-weight: 500; }
    .msg-content tr:nth-child(2n) { background: rgba(255,255,255,0.02); }

    .msg-content blockquote {
      border-left: 3px solid var(--accent);
      color: var(--text-secondary);
      padding-left: 16px;
      margin: 16px 0;
      font-style: italic;
    }

    /* ── Meta / tool info ────────────── */
    .meta {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-top: 8px;
      display: flex; align-items: center; gap: 6px;
    }
    .meta::before {
      content: '⚡';
      font-size: 10px;
    }

    /* ── Input Area ──────────────────── */
    .input-wrapper {
      position: absolute;
      bottom: 0;
      left: 0; right: 0;
      padding: 16px;
      background: linear-gradient(transparent, var(--bg-primary) 30%);
      z-index: 10;
    }
    .input-container {
      max-width: var(--max-width);
      margin: 0 auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--shape-xl);
      display: flex;
      flex-direction: column;
      transition: border-color var(--duration-short) var(--motion-standard), box-shadow var(--duration-short) var(--motion-standard);
    }
    .input-row {
      display: flex;
      align-items: center;
      padding: 6px 8px 2px 12px;
      gap: 4px;
    }
    .attach-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      width: 36px; height: 36px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      transition: background var(--duration-short) var(--motion-standard), color var(--duration-short);
      flex-shrink: 0;
    }
    .attach-btn:hover { background: rgba(207,188,255,0.08); color: var(--accent); }

    /* ── Model Picker ──────────────── */
    .model-picker-row {
      display: flex;
      align-items: center;
      padding: 2px 10px 8px;
      position: relative;
    }
    .model-picker-btn {
      background: rgba(207,188,255,0.06);
      border: 1px solid rgba(207,188,255,0.1);
      color: var(--text-secondary);
      font-size: 12px;
      font-family: var(--font);
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px 4px 8px;
      border-radius: 16px;
      transition: all 0.2s var(--motion-standard);
      white-space: nowrap;
    }
    .model-picker-btn:hover {
      background: rgba(207,188,255,0.12);
      border-color: rgba(207,188,255,0.2);
      color: var(--text-primary);
    }
    .model-picker-btn .provider-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .model-picker-btn .provider-dot.ollama { background: #34d399; }
    .model-picker-btn .provider-dot.gemini { background: #60a5fa; }
    .model-picker-btn .provider-dot.openrouter { background: #f472b6; }
    .model-picker-btn .provider-dot.chatgpt { background: #10b981; }
    .model-picker-btn .chevron {
      transition: transform 0.2s;
      font-size: 8px;
      opacity: 0.6;
    }
    .model-picker-btn.open { 
      background: rgba(207,188,255,0.15);
      border-color: rgba(207,188,255,0.25);
      color: var(--text-primary);
    }
    .model-picker-btn.open .chevron { transform: rotate(180deg); }
    .model-dropdown {
      display: none;
      position: absolute;
      bottom: calc(100% + 6px);
      left: 0;
      background: var(--surface);
      border: 1px solid rgba(207,188,255,0.15);
      border-radius: 14px;
      min-width: 280px;
      max-height: 360px;
      overflow-y: auto;
      z-index: 100;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(207,188,255,0.05);
      padding: 6px;
      backdrop-filter: blur(16px);
    }
    .model-dropdown.show { display: block; }
    .model-group-label {
      font-size: 10px;
      color: var(--text-secondary);
      padding: 10px 10px 4px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      font-weight: 600;
      opacity: 0.6;
    }
    .model-group-label:first-child { padding-top: 6px; }
    .model-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.15s;
      font-size: 13px;
      font-weight: 450;
      color: var(--text-primary);
    }
    .model-option:hover { background: rgba(207,188,255,0.08); }
    .model-option.active {
      background: rgba(124,58,237,0.12);
      color: var(--accent);
    }
    .model-option .model-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .model-option .model-size {
      font-size: 11px;
      color: var(--text-secondary);
      opacity: 0.5;
      font-weight: 400;
    }
    .model-option .model-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .model-option .model-dot.ollama { background: #34d399; }
    .model-option .model-dot.gemini { background: #60a5fa; }
    .model-option .model-dot.openrouter { background: #f472b6; }
    .model-option .model-dot.chatgpt { background: #10b981; }
    .model-caps {
      display: flex;
      gap: 3px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .model-cap-icon {
      width: 14px; height: 14px;
      opacity: 0.5;
      color: var(--text-secondary);
    }
    .model-cap-icon svg { width: 14px; height: 14px; }
    .attach-preview {
      max-width: var(--max-width);
      margin: 0 auto 8px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      padding: 8px 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--shape-lg);
    }
    .attach-thumb {
      position: relative;
      width: 64px; height: 64px;
      border-radius: var(--shape-sm);
      overflow: hidden;
      background: var(--bg-tertiary);
      display: flex; align-items: center; justify-content: center;
    }
    .attach-thumb img {
      width: 100%; height: 100%;
      object-fit: cover;
    }
    .attach-thumb .file-name {
      font-size: 10px;
      color: var(--text-secondary);
      text-align: center;
      padding: 4px;
      word-break: break-all;
      line-height: 1.2;
    }
    .attach-thumb .remove-attach {
      position: absolute;
      top: 2px; right: 2px;
      width: 18px; height: 18px;
      background: rgba(0,0,0,0.7);
      color: white;
      border: none;
      border-radius: 50%;
      font-size: 11px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      line-height: 1;
    }
    .input-container:focus-within {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-dim);
    }
    #input {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-size: 16px;
      font-family: var(--font);
      padding: 12px 0;
      outline: none;
      line-height: 1.4;
      resize: none;
      overflow-y: auto;
      max-height: 160px;
      min-height: 22px;
    }
    #input::placeholder { color: var(--text-tertiary); }
    #send {
      background: var(--accent);
      color: #131314;
      border: none;
      border-radius: 50%;
      width: 40px; height: 40px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      font-size: 18px;
      transition: all var(--duration-short) var(--motion-standard);
      flex-shrink: 0;
    }
    #send:hover { background: #e8def8; transform: scale(1.05); }
    #send:disabled { background: var(--bg-tertiary); color: var(--text-tertiary); cursor: not-allowed; transform: none; }

    /* ── Welcome State ───────────────── */
    .welcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      gap: 16px;
      padding: 40px;
      text-align: center;
      animation: fadeIn var(--duration-long) var(--motion-decelerate);
    }
    .welcome-icon {
      width: 64px; height: 64px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
    }
    .welcome h2 {
      font-size: 28px;
      font-weight: 400;
      background: linear-gradient(135deg, #c084fc, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .welcome p { color: var(--text-secondary); font-size: 15px; max-width: 400px; }
    .suggestions {
      display: flex; gap: 8px; flex-wrap: wrap; justify-content: center;
      margin-top: 8px;
    }
    .suggestion {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 8px 16px;
      font-size: 13px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
      font-family: var(--font);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      line-height: 1;
    }
    .suggestion svg {
      flex-shrink: 0;
      vertical-align: middle;
    }
    .suggestion:hover {
      background: var(--surface-hover);
      color: var(--text-primary);
      border-color: var(--accent);
    }
    /* ── Typing indicator ── */
    .typing-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 12px 16px;
      flex-wrap: wrap;
    }
    .typing-indicator .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-tertiary);
      animation: typingBounce 1.4s ease-in-out infinite;
    }
    .typing-indicator .dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typingBounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-6px); opacity: 1; }
    }
    /* ── Inline activity status ── */
    .activity-status {
      width: 100%;
      margin-top: 6px;
      font-size: 12px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 6px;
      opacity: 0;
      transition: opacity 0.3s ease;
      min-height: 18px;
    }
    .activity-status.visible { opacity: 1; }
    .activity-status .status-icon { font-size: 14px; }
    .activity-status .status-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* ── Canvas inline bubble ── */
    .canvas-bubble {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--shape-md);
      overflow: hidden;
      margin-top: 4px;
    }
    .canvas-title-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .canvas-title {
      font-size: 11px;
      font-weight: 500;
      color: var(--text-tertiary);
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .canvas-expand-btn {
      background: none;
      border: 1px solid var(--border-subtle);
      color: var(--text-tertiary);
      cursor: pointer;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: var(--shape-xs);
      font-family: var(--font);
      transition: all var(--duration-short) var(--motion-standard);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .canvas-expand-btn:hover {
      background: var(--surface-hover);
      color: var(--text-secondary);
      border-color: var(--border);
    }
    .canvas-iframe {
      width: 100%;
      min-height: 300px;
      max-height: 600px;
      border: none;
      background: #fff;
      border-radius: 0 0 var(--shape-md) var(--shape-md);
    }
    /* Fullscreen canvas */
    .canvas-fullscreen {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: var(--bg-primary);
      border: none;
      border-radius: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
    }
    .canvas-fullscreen .canvas-title-bar {
      padding: 12px 20px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
    }
    .canvas-fullscreen .canvas-iframe {
      flex: 1;
      max-height: none;
      min-height: 0;
      border-radius: 0;
    }
    /* ── Queued message badge ── */
    .queued-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--text-tertiary);
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--surface-hover);
      margin-top: 4px;
      animation: fadeIn 0.3s var(--motion-decelerate);
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    /* ── Activity Console Panel ── */
    .console-panel {
      position: fixed;
      right: 0;
      top: 56px;
      bottom: 0;
      width: 380px;
      background: var(--bg-secondary);
      border-left: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      z-index: 100;
      animation: slideInRight var(--duration-medium) var(--motion-decelerate);
    }
    @keyframes slideInRight {
      from { transform: translateX(100%); }
      to { transform: translateX(0); }
    }
    .console-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      font-family: var(--font);
      font-size: 11px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 1px;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-primary);
    }
    .console-clear-btn, .console-close-btn {
      background: none;
      border: 1px solid transparent;
      color: var(--text-tertiary);
      cursor: pointer;
      font-family: var(--font);
      font-size: 11px;
      padding: 4px 10px;
      border-radius: var(--shape-sm);
      transition: all var(--duration-short) var(--motion-standard);
    }
    .console-clear-btn:hover, .console-close-btn:hover {
      background: var(--surface-hover);
      color: var(--text-secondary);
      border-color: var(--border-subtle);
    }
    .console-log {
      flex: 1;
      overflow-y: auto;
      padding: 10px 14px;
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 1.7;
    }
    .console-log::-webkit-scrollbar { width: 4px; }
    .console-log::-webkit-scrollbar-track { background: transparent; }
    .console-log::-webkit-scrollbar-thumb { background: var(--border-subtle); border-radius: 2px; }
    .console-entry {
      display: flex;
      gap: 8px;
      padding: 3px 0;
      border-bottom: 1px solid var(--border-subtle);
      animation: fadeIn 0.15s var(--motion-decelerate);
    }
    .console-entry:last-child { border-bottom: none; }
    .console-time {
      color: var(--text-tertiary);
      flex-shrink: 0;
      opacity: 0.6;
    }
    .console-action {
      font-weight: 600;
      flex-shrink: 0;
    }
    .console-detail {
      color: var(--text-secondary);
      word-break: break-word;
    }
    /* Action color coding — M3 palette harmonized */
    .action-llm_call { color: var(--accent); }
    .action-llm_done { color: var(--success); }
    .action-tool_call { color: #93b4ff; }
    .action-tool_done { color: var(--success); }
    .action-rate_limit { color: #f5d97e; }
    .action-failover { color: #ffb86c; }
    .action-error { color: var(--error); }
    .action-iteration { color: var(--text-tertiary); }
    /* Tool output streaming styles */
    .tool-output { background: rgba(0,0,0,0.15); border-radius: 4px; margin: 2px 0; padding: 4px 0; }
    .tool-stdout { color: var(--success); }
    .tool-stderr { color: var(--error); }
    .tool-info { color: var(--accent); }
    .tool-pre { margin: 0; font-family: 'Google Sans Mono', monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; color: var(--text-secondary); }
    .action-fallback { color: var(--accent); }
    /* Shrink chat when console is open */
    body.console-open #messages,
    body.console-open .input-wrapper,
    body.console-open #dashboardView {
      margin-right: 380px;
    }
    @media (max-width: 768px) {
      .console-panel { width: 100%; top: 56px; }
      body.console-open #messages,
      body.console-open .input-wrapper,
      body.console-open #dashboardView {
        display: none;
      }
    }
    /* ── Mic recording state ── */
    .mic-recording {
      color: #ef4444 !important;
      animation: micPulse 1.5s ease-in-out infinite;
      filter: drop-shadow(0 0 6px rgba(239,68,68,0.5));
    }
    .mic-recording .mic-icon-idle { display: none; }
    .mic-recording .mic-icon-stop { display: block !important; }
    @keyframes micPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(1.1); }
    }
    /* ── Voice Mode overlay ── */
    .voice-overlay {
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(19,19,20,0.97);
      display: none; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 24px; transition: opacity 0.3s ease;
      opacity: 0;
    }
    .voice-overlay.active { display: flex; opacity: 1; }
    .voice-orb {
      width: 160px; height: 160px; border-radius: 50%;
      background: radial-gradient(circle at 40% 40%, var(--accent), #6366f1, #8b5cf6);
      box-shadow: 0 0 60px rgba(164,130,255,0.4), 0 0 120px rgba(99,102,241,0.2);
      animation: orbIdle 3s ease-in-out infinite;
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }
    .voice-orb.listening {
      animation: orbListening 1.5s ease-in-out infinite;
      box-shadow: 0 0 80px rgba(164,130,255,0.6), 0 0 160px rgba(99,102,241,0.3);
    }
    .voice-orb.thinking {
      animation: orbThinking 1s ease-in-out infinite;
      background: radial-gradient(circle at 40% 40%, #f59e0b, #ef4444, #ec4899);
      box-shadow: 0 0 60px rgba(245,158,11,0.4);
    }
    .voice-orb.speaking {
      animation: orbSpeaking 0.6s ease-in-out infinite;
      background: radial-gradient(circle at 40% 40%, #10b981, #06b6d4, var(--accent));
      box-shadow: 0 0 80px rgba(16,185,129,0.5);
    }
    @keyframes orbIdle {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.03); }
    }
    @keyframes orbListening {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.08); }
    }
    @keyframes orbThinking {
      0%, 100% { transform: scale(1) rotate(0deg); }
      50% { transform: scale(1.05) rotate(5deg); }
    }
    @keyframes orbSpeaking {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.12); }
    }
    .voice-status {
      font-size: 16px; color: var(--text-secondary);
      font-weight: 500; letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .voice-transcript {
      max-width: 500px; text-align: center;
      font-size: 14px; color: var(--text-tertiary);
      line-height: 1.6; min-height: 40px;
      max-height: 120px; overflow-y: auto;
    }
    .voice-end-btn {
      width: 56px; height: 56px; border-radius: 50%;
      background: #ef4444; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.2s ease;
      box-shadow: 0 4px 20px rgba(239,68,68,0.4);
    }
    .voice-end-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 4px 30px rgba(239,68,68,0.6);
    }
    .voice-controls {
      display: flex; gap: 16px; align-items: center; margin-top: 16px;
    }
    .voice-share-btn {
      width: 48px; height: 48px; border-radius: 50%;
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: all 0.2s ease; color: rgba(255,255,255,0.7);
    }
    .voice-share-btn:hover {
      background: rgba(255,255,255,0.2);
      color: white;
    }
    .voice-share-btn.active {
      background: rgba(99,102,241,0.3); border-color: #818cf8;
      color: #818cf8;
    }
    .voice-share-preview {
      position: absolute; bottom: 120px; right: 24px;
      width: 200px; border-radius: 12px; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      display: none;
    }
    .voice-share-preview video {
      width: 100%; display: block;
    }
    .voice-tool-pill {
      display: none; padding: 6px 16px; border-radius: 20px;
      background: rgba(99,102,241,0.2); border: 1px solid rgba(99,102,241,0.3);
      color: #a5b4fc; font-size: 12px; font-weight: 500;
      margin-top: 8px; gap: 6px; align-items: center;
      animation: voiceToolPulse 1.5s ease-in-out infinite;
    }
    .voice-tool-pill.visible { display: inline-flex; }
    @keyframes voiceToolPulse {
      0%, 100% { opacity: 0.7; } 50% { opacity: 1; }
    }
    .notification-bell {
      position: relative; background: transparent; border: none;
      cursor: pointer; color: var(--text-secondary); width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%; transition: all 0.2s;
    }
    .notification-bell:hover { color: var(--text-primary); background: var(--bg-tertiary); }
    .notification-badge {
      position: absolute; top: 2px; right: 2px; width: 8px; height: 8px;
      border-radius: 50%; background: #ef4444; display: none;
    }
    .notification-badge.visible { display: block; }
    .notification-dropdown {
      display: none; position: absolute; top: 40px; right: 0;
      width: 360px; max-height: 400px; overflow-y: auto;
      background: var(--bg-secondary); border: 1px solid var(--border);
      border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      z-index: 1000; padding: 8px 0;
    }
    .notification-dropdown.open { display: block; }
    .notification-dropdown-header {
      padding: 12px 16px; font-weight: 600; font-size: 14px;
      color: var(--text-primary); border-bottom: 1px solid var(--border);
      display: flex; justify-content: space-between; align-items: center;
    }
    .notification-item {
      padding: 10px 16px; font-size: 13px; color: var(--text-secondary);
      border-bottom: 1px solid rgba(255,255,255,0.03);
      display: flex; gap: 10px; align-items: flex-start;
    }
    .notification-item:last-child { border-bottom: none; }
    .notification-time { font-size: 11px; color: var(--text-tertiary); white-space: nowrap; }
    .notification-empty {
      padding: 24px 16px; text-align: center;
      color: var(--text-tertiary); font-size: 13px;
    }
    .deep-research-bar {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 16px; border-radius: 12px;
      background: var(--bg-tertiary); border: 1px solid rgba(99,102,241,0.2);
      margin: 8px 0; font-size: 13px; color: var(--text-secondary);
    }
    .deep-research-bar .progress-track {
      flex: 1; height: 4px; border-radius: 2px;
      background: rgba(255,255,255,0.1); overflow: hidden;
    }
    .deep-research-bar .progress-fill {
      height: 100%; border-radius: 2px;
      background: linear-gradient(90deg, #818cf8, #a78bfa);
      animation: researchProgress 3s ease-in-out infinite;
    }
    @keyframes researchProgress {
      0% { width: 10%; } 50% { width: 70%; } 100% { width: 10%; }
    }
    .kg-btn {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-secondary); width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%; transition: all 0.2s;
    }
    .kg-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }
    .kg-modal {
      display: none; position: fixed; inset: 0; z-index: 10000;
      background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
      align-items: center; justify-content: center;
    }
    .kg-modal.open { display: flex; }
    .kg-panel {
      width: 90%; max-width: 800px; max-height: 80vh;
      background: var(--bg-secondary); border: 1px solid var(--border);
      border-radius: 16px; overflow: hidden; display: flex; flex-direction: column;
    }
    .kg-header {
      padding: 16px 20px; font-weight: 600; font-size: 16px;
      border-bottom: 1px solid var(--border); display: flex;
      justify-content: space-between; align-items: center;
    }
    .kg-body {
      flex: 1; overflow-y: auto; padding: 16px 20px;
    }
    .kg-entity-card {
      padding: 12px 16px; border-radius: 10px;
      background: var(--bg-tertiary); margin-bottom: 10px;
      border: 1px solid var(--border);
    }
    .kg-entity-name { font-weight: 600; font-size: 14px; color: var(--text-primary); }
    .kg-entity-type {
      display: inline-block; padding: 2px 8px; border-radius: 12px;
      background: rgba(99,102,241,0.15); color: #a5b4fc;
      font-size: 11px; font-weight: 500; margin-left: 8px;
    }
    .kg-entity-desc { font-size: 13px; color: var(--text-secondary); margin-top: 4px; }
    .kg-entity-rels { margin-top: 8px; }
    .kg-rel {
      font-size: 12px; color: var(--text-tertiary); padding: 2px 0;
    }
    .kg-rel-arrow { color: #818cf8; }
    .kg-empty { text-align: center; padding: 40px; color: var(--text-tertiary); }
    .kg-search {
      width: 100%; padding: 8px 12px; border-radius: 8px;
      background: var(--bg-primary); border: 1px solid var(--border);
      color: var(--text-primary); font-size: 13px; margin-bottom: 12px;
      outline: none;
    }
    .kg-search:focus { border-color: #818cf8; }
    .voice-mode-btn {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-secondary);
      width: 36px; height: 36px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      transition: background var(--duration-short) var(--motion-standard), color var(--duration-short);
      flex-shrink: 0;
    }
    .voice-mode-btn:hover {
      color: var(--accent); background: rgba(164,130,255,0.1);
    }
  </style>
</head>
<body>
  <!-- Sidebar -->
  <aside class="sidebar collapsed" id="sidebar">
    <div class="sidebar-header">
      <button class="sidebar-new-chat" id="sidebarNewChat">＋ New chat</button>
    </div>
    <div class="sidebar-nav" id="sidebarNav">
      <div class="sidebar-group-label">Dashboard</div>
      <div class="sidebar-item sidebar-nav-item" data-page="command_center">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        <span class="sidebar-item-title">Command Center</span>
      </div>
      <div class="sidebar-item sidebar-nav-item" data-page="tools">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.39 4.39a1 1 0 0 0 1.68-.474a2.5 2.5 0 1 1 3.014 3.015a1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474a2.5 2.5 0 1 0-3.014 3.015a1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474a2.5 2.5 0 1 1-3.014-3.015a1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474a2.5 2.5 0 1 0 3.014-3.015a1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/></svg>
        <span class="sidebar-item-title">Tools & Plugins</span>
      </div>
      <div class="sidebar-item sidebar-nav-item" data-page="memory">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
        <span class="sidebar-item-title">Memory</span>
      </div>
      <div class="sidebar-item sidebar-nav-item" data-page="reminders">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0m-10.47-5.674A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>
        <span class="sidebar-item-title">Reminders</span>
      </div>
      <div class="sidebar-item sidebar-nav-item" data-page="personas">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11h.01M14 6h.01M18 6h.01M6.5 13.1h.01M22 5c0 9-4 12-6 12s-6-3-6-12q0-3 6-3c6 0 6 1 6 3"/><path d="M17.4 9.9c-.8.8-2 .8-2.8 0m-4.5-2.8C9 7.2 7.7 7.7 6 8.6c-3.5 2-4.7 3.9-3.7 5.6c4.5 7.8 9.5 8.4 11.2 7.4c.9-.5 1.9-2.1 1.9-4.7"/><path d="M9.1 16.5c.3-1.1 1.4-1.7 2.4-1.4"/></svg>
        <span class="sidebar-item-title">Personas</span>
      </div>
      <div class="sidebar-item sidebar-nav-item" data-page="connections">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <span class="sidebar-item-title">Connections</span>
      </div>
      <div class="sidebar-item sidebar-nav-item" data-page="settings">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        <span class="sidebar-item-title">Settings</span>
      </div>
    </div>
    <div class="sidebar-group-label" style="margin-top:4px">Conversations</div>
    <div style="padding:0 12px 8px">
      <input type="text" id="sessionSearch" placeholder="Search conversations…" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;outline:none;" />
    </div>
    <div class="sidebar-list" id="sessionList"></div>
  </aside>
  <div class="sidebar-overlay" id="sidebarOverlay"></div>

  <!-- Main -->
  <div class="main">
    <header>
      <button class="menu-btn" id="menuBtn" title="Toggle sidebar">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 12h16M4 19h16"/></svg>
      </button>
      <div class="logo"><img src="/alice-icon-512.png" alt="Alice" width="36" height="36" style="border-radius:50%"></div>
      <h1>Alice</h1>
      <div class="status-badge" id="status">
        <span class="status-dot"></span>
        Online
      </div>
      <div class="header-spacer"></div>
      <div class="header-actions">
        <button class="header-btn" id="consoleToggle" title="Toggle activity console">⚙<span class="btn-label"> Console</span></button>
        <button class="header-btn" id="newChatBtn">＋<span class="btn-label"> New Chat</span></button>
      </div>
    </header>

    <div id="messages">
      <div class="welcome" id="welcome">
        <div class="welcome-icon"><img src="/alice-icon-512.png" alt="Alice" style="width:80px;height:80px;border-radius:50%"></div>
        <h2>Hi, I’m Alice</h2>
        <p>Your personal AI agent. I can write code, search the web, manage files, and much more.</p>
        <div class="suggestions">
          <button class="suggestion" data-msg="What tools do you have?"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/></svg> What can you do?</button>
          <button class="suggestion" data-msg="Show me the git status of this project"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg> Git status</button>
          <button class="suggestion" data-msg="Search my memory for recent topics"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18V5m3 8a4.17 4.17 0 0 1-3-4a4.17 4.17 0 0 1-3 4m8.598-6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/></svg> Search memory</button>
          <button class="suggestion" data-msg="Set a reminder in 5 minutes to take a break"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Set reminder</button>
        </div>
      </div>
    </div>

    <!-- Activity Console Panel -->
    <div id="consolePanel" class="console-panel" style="display: none;">
      <div class="console-header">
        <span>Activity Console</span>
        <div style="display:flex;gap:8px;">
          <button id="consoleClear" class="console-clear-btn">Clear</button>
          <button id="consoleClose" class="console-close-btn">✕</button>
        </div>
      </div>
      <div id="consoleLog" class="console-log"></div>
    </div>

    <div id="dashboardView" style="display:none; padding: 32px 24px; overflow-y: auto; flex: 1;">
    </div>

    <div class="input-wrapper">
      <div class="input-container">
        <div id="attachPreview" class="attach-preview" style="display:none;"></div>
        <div class="input-row">
        <button id="attachBtn" class="attach-btn" title="Attach file">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 6l-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/></svg>
        </button>
        <textarea id="input" placeholder="Message Alice…" autofocus autocomplete="off" rows="1"></textarea>
        <button id="micBtn" class="attach-btn" title="Voice dictation" style="display:none;">
          <svg class="mic-icon-idle" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
          <svg class="mic-icon-stop" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>
        </button>
        <button id="kgBtn" class="kg-btn" title="Knowledge Graph">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="4" cy="6" r="2"/><circle cx="20" cy="6" r="2"/><circle cx="4" cy="18" r="2"/><circle cx="20" cy="18" r="2"/><line x1="6" y1="7" x2="10" y2="10"/><line x1="18" y1="7" x2="14" y2="10"/><line x1="6" y1="17" x2="10" y2="14"/><line x1="18" y1="17" x2="14" y2="14"/></svg>
        </button>
        <div style="position:relative;">
          <button id="notifBell" class="notification-bell" title="Notifications">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0m-10.47-5.674A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>
            <span id="notifBadge" class="notification-badge"></span>
          </button>
          <div id="notifDropdown" class="notification-dropdown">
            <div class="notification-dropdown-header">
              <span>Notifications</span>
              <button id="notifClear" style="background:none;border:none;color:var(--text-tertiary);cursor:pointer;font-size:12px;">Clear all</button>
            </div>
            <div id="notifList"><div class="notification-empty">No notifications yet</div></div>
          </div>
        </div>
        <button id="voiceModeBtn" class="voice-mode-btn" title="Voice conversation">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="9" width="2" height="6" rx="1"/><rect x="8" y="5" width="2" height="14" rx="1"/><rect x="12" y="3" width="2" height="18" rx="1"/><rect x="16" y="7" width="2" height="10" rx="1"/><rect x="20" y="10" width="2" height="4" rx="1"/></svg>
        </button>
        <button id="send"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11zm7.318-19.539l-10.94 10.939"/></svg></button>
        </div>
        <div class="model-picker-row">
          <button class="model-picker-btn" id="modelPickerBtn">
            <span class="provider-dot ollama" id="modelProviderDot"></span>
            <span id="modelPickerLabel">Loading...</span>
            <span class="chevron">▲</span>
          </button>
          <div class="model-dropdown" id="modelDropdown"></div>
        </div>
      </div>
      <input type="file" id="fileInput" accept="image/*,.pdf,.txt,.csv,.json,.md" multiple style="display:none;" />
    </div>
  </div><!-- /main -->

  <!-- Voice Mode Overlay -->
  <div id="voiceOverlay" class="voice-overlay">
    <div id="voiceOrb" class="voice-orb"></div>
    <div id="voiceStatus" class="voice-status">Connecting…</div>
    <div id="voiceTranscript" class="voice-transcript"></div>
    <div id="voiceToolPill" class="voice-tool-pill">🔧 <span id="voiceToolName">Searching…</span></div>
    <div class="voice-controls">
      <button id="voiceShareBtn" class="voice-share-btn" title="Share your screen">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      </button>
      <button id="voiceEndBtn" class="voice-end-btn" title="End voice conversation">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="white" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
      </button>
    </div>
    <div id="voiceSharePreview" class="voice-share-preview">
      <video id="voiceShareVideo" autoplay muted playsinline></video>
    </div>
  </div>

  <!-- Knowledge Graph Modal -->
  <div id="kgModal" class="kg-modal">
    <div class="kg-panel">
      <div class="kg-header">
        <span>🧠 Knowledge Graph</span>
        <button id="kgClose" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:18px;">✕</button>
      </div>
      <div class="kg-body">
        <input id="kgSearch" class="kg-search" placeholder="Search entities…" />
        <div id="kgEntities"></div>
      </div>
    </div>
  </div>


  <script>
    // White SVG sparkle icon for avatars
    const SPARKLE_SVG = '<img src="/alice-icon-512.png" alt="Alice">';

    // Use marked-highlight extension for syntax highlighting
    if (typeof markedHighlight !== 'undefined') {
      marked.use(markedHighlight.markedHighlight({
        langPrefix: 'hljs language-',
        highlight: function(code, lang) {
          if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
          return hljs.highlightAuto(code).value;
        }
      }));
    }
    marked.use({ breaks: true, gfm: true });

    // Fetch user profile picture
    window.__userPicture = null;
    fetch('/api/userinfo').then(r => r.json()).then(data => {
      if (data.picture) window.__userPicture = data.picture;
    }).catch(() => {});

    var ws;
    var wsRetryDelay = 1000;
    function connectWS() {
      ws = new WebSocket('ws://' + location.host);
      window._aliceWs = ws;
      ws.onopen = () => {
        wsRetryDelay = 1000;
        var status = document.getElementById('status');
        status.innerHTML = '<span class="status-dot"></span> Online';
        status.style.color = 'var(--success)';
        status.style.background = 'rgba(129,201,149,0.1)';
        send.disabled = false;
      };
      ws.onmessage = wsOnMessage;
      ws.onerror = (err) => console.error('WebSocket error:', err);
      ws.onclose = () => {
        var status = document.getElementById('status');
        status.innerHTML = '<span class="status-dot" style="background:#f28b82;animation:none"></span> Offline';
        status.style.color = '#f28b82';
        status.style.background = 'rgba(242,139,130,0.1)';
        send.disabled = true;
        // Auto-retry with backoff
        setTimeout(() => { if (document.visibilityState !== 'hidden') connectWS(); }, wsRetryDelay);
        wsRetryDelay = Math.min(wsRetryDelay * 2, 8000);
      };
    }
    // Reconnect when app comes back to foreground
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) {
        connectWS();
      }
    });

    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const welcome = document.getElementById('welcome');
    const clearBtn = document.getElementById('clearBtn');

    connectWS();

    // ── Activity Console Panel ──
    const consolePanel = document.getElementById('consolePanel');
    const consoleLog = document.getElementById('consoleLog');
    const consoleToggle = document.getElementById('consoleToggle');
    const consoleClear = document.getElementById('consoleClear');
    const consoleClose = document.getElementById('consoleClose');

    function toggleConsole() {
      const isOpen = consolePanel.style.display !== 'none';
      consolePanel.style.display = isOpen ? 'none' : 'flex';
      document.body.classList.toggle('console-open', !isOpen);
    }
    consoleToggle.addEventListener('click', toggleConsole);
    consoleClose.addEventListener('click', toggleConsole);
    consoleClear.addEventListener('click', () => { consoleLog.innerHTML = ''; });

    function addActivity(action, detail) {
      const entry = document.createElement('div');
      entry.className = 'console-entry';
      const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const icon = {
        llm_call: '🧠', llm_done: '✅', tool_call: '🔧', tool_done: '✅',
        rate_limit: '⏳', failover: '⚡', error: '❌', iteration: '🔄', fallback: '🔀'
      }[action] || '📋';
      entry.innerHTML = '<span class=\"console-time\">' + time + '</span>' +
        '<span class=\"console-action action-' + action + '\">' + icon + ' ' + action + '</span>' +
        '<span class=\"console-detail\">' + (detail || '') + '</span>';
      consoleLog.appendChild(entry);
      consoleLog.scrollTop = consoleLog.scrollHeight;
    }

    // Shared canvas bubble renderer — used by live WS events and session replay
    function renderCanvasBubble(html, canvasTitle) {
      hideWelcome();
      const row = document.createElement('div');
      row.className = 'msg-row agent';

      const avatar = document.createElement('div');
      avatar.className = 'avatar alice';
      avatar.innerHTML = SPARKLE_SVG;
      row.appendChild(avatar);

      const bubble = document.createElement('div');
      bubble.className = 'canvas-bubble';

      const titleBar = document.createElement('div');
      titleBar.className = 'canvas-title-bar';
      const title = document.createElement('div');
      title.className = 'canvas-title';
      title.textContent = canvasTitle || 'Canvas';
      titleBar.appendChild(title);

      const expandBtn = document.createElement('button');
      expandBtn.className = 'canvas-expand-btn';
      expandBtn.innerHTML = '⛶ Expand';
      let isFullscreen = false;
      expandBtn.addEventListener('click', function() {
        isFullscreen = !isFullscreen;
        bubble.classList.toggle('canvas-fullscreen', isFullscreen);
        expandBtn.innerHTML = isFullscreen ? '✕ Close' : '⛶ Expand';
        if (isFullscreen) {
          const onEsc = function(e) {
            if (e.key === 'Escape') {
              isFullscreen = false;
              bubble.classList.remove('canvas-fullscreen');
              expandBtn.innerHTML = '⛶ Expand';
              document.removeEventListener('keydown', onEsc);
            }
          };
          document.addEventListener('keydown', onEsc);
        }
      });
      titleBar.appendChild(expandBtn);
      bubble.appendChild(titleBar);

      const iframe = document.createElement('iframe');
      iframe.className = 'canvas-iframe';
      iframe.sandbox = 'allow-scripts allow-same-origin';
      iframe.srcdoc = html;
      iframe.addEventListener('load', function() {
        try {
          const h = iframe.contentDocument?.documentElement?.scrollHeight;
          if (h && h > 0) iframe.style.height = Math.min(h + 16, 600) + 'px';
        } catch(e) {}
      });
      bubble.appendChild(iframe);
      row.appendChild(bubble);
      messages.appendChild(row);
      messages.scrollTop = messages.scrollHeight;
    }

    function hideWelcome() {
      if (welcome) welcome.style.display = 'none';
    }

    function addMsg(text, type, meta, attachments) {
      hideWelcome();
      const row = document.createElement('div');
      row.className = 'msg-row ' + type;

      if (type === 'agent') {
        const avatar = document.createElement('div');
        avatar.className = 'avatar alice';
        avatar.innerHTML = SPARKLE_SVG;
        row.appendChild(avatar);
      }

      const content = document.createElement('div');
      content.className = 'msg-content';

      // Show inline attachment thumbnails for user messages
      if (attachments && attachments.length > 0) {
        const strip = document.createElement('div');
        strip.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;';
        attachments.forEach(att => {
          if (att.type && att.type.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = 'data:' + att.type + ';base64,' + att.data;
            img.style.cssText = 'max-width:200px;max-height:150px;border-radius:10px;';
            strip.appendChild(img);
          } else {
            const badge = document.createElement('span');
            badge.style.cssText = 'background:var(--bg-tertiary);padding:4px 10px;border-radius:8px;font-size:12px;color:var(--text-secondary);';
            badge.textContent = '📄 ' + att.name;
            strip.appendChild(badge);
          }
        });
        content.appendChild(strip);
      }

      if (type === 'agent') {
        try {
          content.innerHTML += marked.parse(text);
          addCopyButtons(content);
        } catch (err) {
          content.textContent = text;
        }
      } else {
        const textEl = document.createElement('span');
        textEl.textContent = text;
        content.appendChild(textEl);
      }

      if (meta) {
        const m = document.createElement('div');
        m.className = 'meta';
        m.textContent = meta;
        content.appendChild(m);
      }

      if (type === 'user') {
        row.appendChild(content);
        const avatar = document.createElement('div');
        avatar.className = 'avatar user-av';
        if (window.__userPicture) {
          const img = document.createElement('img');
          img.src = window.__userPicture;
          img.alt = 'You';
          avatar.appendChild(img);
        } else {
          avatar.textContent = 'A';
        }
        row.appendChild(avatar);
      } else {
        row.appendChild(content);
      }

      messages.appendChild(row);
      messages.scrollTop = messages.scrollHeight;
    }

    function showThinking() {
      hideWelcome();
      const row = document.createElement('div');
      row.className = 'msg-row agent';
      row.id = 'thinking-row';

      const avatar = document.createElement('div');
      avatar.className = 'avatar alice';
      avatar.innerHTML = SPARKLE_SVG;
      row.appendChild(avatar);

      const content = document.createElement('div');
      content.className = 'typing-indicator';
      content.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>' +
        '<div class="activity-status" id="activity-status">' +
        '<span class="status-icon">🧠</span>' +
        '<span class="status-text">Thinking...</span>' +
        '</div>';
      row.appendChild(content);

      messages.appendChild(row);
      messages.scrollTop = messages.scrollHeight;
      return row;
    }

    function addCopyButtons(container) {
      container.querySelectorAll('pre code').forEach(function(codeEl) {
        const pre = codeEl.parentElement;
        const langClass = Array.from(codeEl.classList).find(c => c.startsWith('language-'));
        const lang = langClass ? langClass.replace('language-', '') : '';

        const header = document.createElement('div');
        header.className = 'code-header';

        const langSpan = document.createElement('span');
        langSpan.className = 'code-lang';
        langSpan.textContent = lang || 'code';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.innerHTML = '📋 Copy';
        copyBtn.addEventListener('click', function() {
          navigator.clipboard.writeText(codeEl.textContent || '').then(function() {
            copyBtn.innerHTML = '✓ Copied';
            copyBtn.classList.add('copied');
            setTimeout(function() {
              copyBtn.innerHTML = '📋 Copy';
              copyBtn.classList.remove('copied');
            }, 2000);
          });
        });

        header.appendChild(langSpan);
        header.appendChild(copyBtn);
        pre.insertBefore(header, pre.firstChild);
      });
    }

    // ── File Attachment Handling ──────────────────
    const attachBtn = document.getElementById('attachBtn');
    const fileInput = document.getElementById('fileInput');
    const attachPreview = document.getElementById('attachPreview');
    let pendingAttachments = [];

    attachBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      files.forEach(file => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          pendingAttachments.push({
            name: file.name,
            type: file.type,
            data: base64,
          });
          renderAttachPreview();
        };
        reader.readAsDataURL(file);
      });
      fileInput.value = '';
    });

    function renderAttachPreview() {
      attachPreview.innerHTML = '';
      if (pendingAttachments.length === 0) {
        attachPreview.style.display = 'none';
        return;
      }
      attachPreview.style.display = 'flex';
      pendingAttachments.forEach((att, i) => {
        const thumb = document.createElement('div');
        thumb.className = 'attach-thumb';
        if (att.type.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = 'data:' + att.type + ';base64,' + att.data;
          thumb.appendChild(img);
        } else {
          const span = document.createElement('span');
          span.className = 'file-name';
          span.textContent = att.name;
          thumb.appendChild(span);
        }
        const rm = document.createElement('button');
        rm.className = 'remove-attach';
        rm.textContent = '✕';
        rm.onclick = () => {
          pendingAttachments.splice(i, 1);
          renderAttachPreview();
        };
        thumb.appendChild(rm);
        attachPreview.appendChild(thumb);
      });
    }

    function sendMessage() {
      const text = input.value.trim();
      if ((!text && pendingAttachments.length === 0) || send.disabled) return;

      // Show user message with attachment previews
      const displayText = text || '(attached file' + (pendingAttachments.length > 1 ? 's' : '') + ')';
      addMsg(displayText, 'user', null, pendingAttachments);

      // Send as JSON with attachments
      const payload = { text: text || '', attachments: pendingAttachments };
      ws.send(JSON.stringify(payload));

      input.value = '';
      input.style.height = 'auto';
      pendingAttachments = [];
      renderAttachPreview();
      send.disabled = true;
    }

    let currentStreamRow = null;
    let currentStreamContent = null;
    let currentStreamText = '';
    let thinkingRow = null;

    function wsOnMessage(e) {
      const data = JSON.parse(e.data);

      // Skip voice mode messages — handled by voice mode's own listener
      if (data.type && data.type.startsWith('voice_')) return;

      // Server-sent typing indicator (shown while Alice processes)
      if (data.type === 'typing') {
        if (!thinkingRow) {
          thinkingRow = showThinking();
        }
        return;
      }

      // Smart notification toast
      if (data.type === 'notification') {
        const colors = { info: '#8ab4f8', warning: '#fdd663', urgent: '#f28b82' };
        const icons = { info: 'ℹ️', warning: '⚠️', urgent: '🚨' };
        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;padding:12px 20px;border-radius:12px;background:var(--bg-tertiary);border:1px solid ' + (colors[data.priority] || colors.info) + ';color:var(--text-primary);font-size:14px;max-width:380px;box-shadow:0 8px 24px rgba(0,0,0,0.3);animation:slideIn 0.3s ease;';
        toast.innerHTML = (icons[data.priority] || '🔔') + ' ' + (data.message || 'Notification');
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 6000);
        return;
      }

      // Canvas: render inline interactive HTML
      if (data.type === 'canvas') {
        renderCanvasBubble(data.html, data.title);
        return;
      }

      // Activity events — update inline status + console
      if (data.type === 'activity') {
        addActivity(data.action, data.detail);
        // Update the inline status bar in the chat area
        const statusEl = document.getElementById('activity-status');
        if (statusEl) {
          const statusMap = {
            tool_call: { icon: '🔧', label: function(d) {
              const name = (d || '').split('(')[0];
              const friendly = {
                bash: 'Running command',
                delegate_task: 'Deploying sub-agent',
                code: 'Running coding agent',
                web_search: 'Searching the web',
                read_file: 'Reading file',
                write_file: 'Writing file',
                edit_file: 'Editing file',
                browse_page: 'Browsing page',
                semantic_search: 'Searching codebase',
                search_memory: 'Searching memory',
                search_codebase: 'Searching codebase',
                workspace_status: 'Checking workspace',
                generate_image: 'Generating image',
                set_reminder: 'Setting reminder',
                create_cron_job: 'Creating scheduled job',
              };
              return friendly[name] || ('Using ' + name);
            }},
            tool_done: { icon: '✅', label: function(d) { return d || 'Done'; } },
            llm_call: { icon: '🧠', label: function() { return 'Thinking...'; } },
            llm_done: { icon: '✨', label: function(d) { return d || 'Response ready'; } },
            rate_limit: { icon: '⏳', label: function(d) { return d || 'Rate limited, waiting...'; } },
            failover: { icon: '⚡', label: function(d) { return d || 'Switching provider'; } },
            iteration: { icon: '🔄', label: function(d) { return d || 'Processing...'; } },
            error: { icon: '❌', label: function(d) { return d || 'Error'; } },
          };
          const info = statusMap[data.action];
          if (info) {
            statusEl.querySelector('.status-icon').textContent = info.icon;
            statusEl.querySelector('.status-text').textContent = typeof info.label === 'function' ? info.label(data.detail) : info.label;
            statusEl.classList.add('visible');
          }
        }
        return;
      }

      // Streaming tool output (bash, sub-agent, coding agent)
      if (data.type === 'tool_output') {
        // Auto-show console on tool output
        if (consolePanel.style.display === 'none') {
          consolePanel.style.display = 'flex';
          document.body.classList.add('console-open');
        }
        const entry = document.createElement('div');
        entry.className = 'console-entry tool-output';
        const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const streamClass = data.stream === 'stderr' ? 'tool-stderr' : (data.stream === 'info' ? 'tool-info' : 'tool-stdout');
        const icon = data.stream === 'stderr' ? '⚠️' : (data.stream === 'info' ? '📡' : '💻');
        entry.innerHTML = '<span class="console-time">' + time + '</span>' +
          '<span class="console-action ' + streamClass + '">' + icon + ' ' + (data.tool || 'tool') + '</span>' +
          '<pre class="console-detail tool-pre">' + (data.chunk || '').replace(/</g, '&lt;') + '</pre>';
        consoleLog.appendChild(entry);
        consoleLog.scrollTop = consoleLog.scrollHeight;
        return;
      }

      // Queued: show badge on the last user message
      if (data.type === 'queued') {
        const userRows = messages.querySelectorAll('.msg-row.user');
        const lastUserRow = userRows[userRows.length - 1];
        if (lastUserRow && !lastUserRow.querySelector('.queued-badge')) {
          const badge = document.createElement('div');
          badge.className = 'queued-badge';
          badge.textContent = '⏳ Queued' + (data.position > 1 ? ' (#' + data.position + ')' : '');
          lastUserRow.appendChild(badge);
        }
        return;
      }

      // Location request: get browser geolocation and send back
      if (data.type === 'location_request') {
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            function(pos) {
              ws.send(JSON.stringify({
                type: 'location',
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: pos.coords.accuracy
              }));
            },
            function(err) {
              ws.send(JSON.stringify({
                type: 'location_error',
                error: err.message || 'Location permission denied'
              }));
            },
            { enableHighAccuracy: true, timeout: 10000 }
          );
        } else {
          ws.send(JSON.stringify({
            type: 'location_error',
            error: 'Geolocation API not available in this browser'
          }));
        }
        return;
      }

      if (data.type === 'token') {
        // Remove thinking indicator on first token
        if (thinkingRow) {
          thinkingRow.remove();
          thinkingRow = null;
        }

        if (!currentStreamRow) {
          hideWelcome();
          currentStreamRow = document.createElement('div');
          currentStreamRow.className = 'msg-row agent';

          const avatar = document.createElement('div');
          avatar.className = 'avatar alice';
          avatar.innerHTML = SPARKLE_SVG;
          currentStreamRow.appendChild(avatar);

          currentStreamContent = document.createElement('div');
          currentStreamContent.className = 'msg-content';
          currentStreamRow.appendChild(currentStreamContent);

          messages.appendChild(currentStreamRow);
          currentStreamText = '';
        }
        currentStreamText += data.text;
        currentStreamContent.textContent = currentStreamText;
        messages.scrollTop = messages.scrollHeight;
        return;
      }

      if (data.type === 'done') {
        if (thinkingRow) { thinkingRow.remove(); thinkingRow = null; }
        // Capture text for TTS before it's cleared
        const spokenText = currentStreamText || data.text || '';

        const meta = data.toolsUsed?.length
          ? data.toolsUsed.join(', ') + ' · ' + data.iterations + ' iterations'
          : '';

        if (currentStreamRow && currentStreamContent) {
          try {
            currentStreamContent.innerHTML = marked.parse(currentStreamText);
            addCopyButtons(currentStreamContent);
          } catch (err) {}
          if (meta) {
            const m = document.createElement('div');
            m.className = 'meta';
            m.textContent = meta;
            currentStreamContent.appendChild(m);
          }
          currentStreamRow = null;
          currentStreamContent = null;
          currentStreamText = '';
        } else {
          addMsg(data.text || data.error || 'No response', 'agent', meta);
        }
        send.disabled = false;
        messages.scrollTop = messages.scrollHeight;

        return;
      }

      // Legacy format
      const meta = data.toolsUsed?.length
        ? data.toolsUsed.join(', ') + ' · ' + data.iterations + ' iterations'
        : '';
      addMsg(data.text || data.error || 'No response', 'agent', meta);
      send.disabled = false;
    }

    send.addEventListener('click', () => {
      sendMessage();
      thinkingRow = showThinking();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
        thinkingRow = showThinking();
      }
    });
    // Auto-resize textarea as user types
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });

    // ── Model Picker ──
    const modelPickerBtn = document.getElementById('modelPickerBtn');
    const modelPickerLabel = document.getElementById('modelPickerLabel');
    const modelDropdown = document.getElementById('modelDropdown');
    let modelPickerOpen = false;

    function capIcons(caps) {
      if (!caps || !caps.length) return '';
      let html = '<span class="model-caps">';
      if (caps.includes('vision')) html += '<span class="model-cap-icon" title="Vision"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/><\/svg><\/span>';
      if (caps.includes('reasoning')) html += '<span class="model-cap-icon" title="Reasoning"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3 4 4.5 4.5 0 0 1-3-4"/><path d="M12 18v4h4"/><\/svg><\/span>';
      html += '<\/span>';
      return html;
    }

    function renderModelOption(m, active) {
      const isActive = m.provider === active.provider && m.id === active.model;
      return '<div class="model-option' + (isActive ? ' active' : '') + '" data-provider="' + m.provider + '" data-model="' + m.id + '">'
        + '<span class="model-dot ' + m.provider + '"><\/span>'
        + '<span class="model-name">' + m.name + '<\/span>'
        + (m.size ? '<span class="model-size">' + m.size + '<\/span>' : '')
        + capIcons(m.capabilities)
        + '<\/div>';
    }

    function renderModelDropdown(models, active) {
      const groups = [
        { key: 'ollama', label: 'Local' },
        { key: 'gemini', label: 'Gemini' },
        { key: 'openrouter', label: 'OpenRouter' },
        { key: 'chatgpt', label: 'ChatGPT' },
      ];
      let html = '';
      groups.forEach(g => {
        const items = models.filter(m => m.provider === g.key);
        if (!items.length) return;
        html += '<div class="model-group-label">' + g.label + '<\/div>';
        items.forEach(m => { html += renderModelOption(m, active); });
      });
      modelDropdown.innerHTML = html;

      modelDropdown.querySelectorAll('.model-option').forEach(opt => {
        opt.addEventListener('click', async () => {
          const provider = opt.dataset.provider;
          const model = opt.dataset.model;
          modelPickerLabel.textContent = opt.querySelector('.model-name').textContent;
          const dot = document.getElementById('modelProviderDot');
          dot.className = 'provider-dot ' + provider;
          closeModelPicker();
          try {
            await fetch('/api/models/switch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider, model }),
            });
            loadModels();
          } catch (e) { console.error('Model switch failed:', e); }
        });
      });
    }

    async function loadModels() {
      try {
        const resp = await fetch('/api/models');
        const data = await resp.json();
        if (data.models && data.active) {
          renderModelDropdown(data.models, data.active);
          const activeModel = data.models.find(m => m.id === data.active.model && m.provider === data.active.provider);
          modelPickerLabel.textContent = activeModel ? activeModel.name : data.active.model;
          const dot = document.getElementById('modelProviderDot');
          dot.className = 'provider-dot ' + data.active.provider;
        }
      } catch (e) {
        modelPickerLabel.textContent = 'Offline';
      }
    }

    function closeModelPicker() {
      modelPickerOpen = false;
      modelDropdown.classList.remove('show');
      modelPickerBtn.classList.remove('open');
    }

    modelPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      modelPickerOpen = !modelPickerOpen;
      modelDropdown.classList.toggle('show', modelPickerOpen);
      modelPickerBtn.classList.toggle('open', modelPickerOpen);
    });

    document.addEventListener('click', (e) => {
      if (modelPickerOpen && !modelDropdown.contains(e.target)) {
        closeModelPicker();
      }
    });

    loadModels();

    // ── Voice Dictation (Native bridge + Web Speech API + Server fallback) ──
    const micBtn = document.getElementById('micBtn');
    const isElectron = navigator.userAgent.includes('Electron');
    const SpeechRecognition = !isElectron ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
    const hasNativeSpeech = window._nativeSpeech && window._nativeSpeech.available;
    const hasServerTranscribe = true; // /api/transcribe is always available
    
    if ((hasNativeSpeech || SpeechRecognition || hasServerTranscribe) && micBtn) {
      micBtn.style.display = '';
      let recognition = null;
      let isListening = false;

      const micIdle = micBtn.querySelector('.mic-icon-idle');
      const micStop = micBtn.querySelector('.mic-icon-stop');
      
      function setMicRecording() {
        isListening = true;
        if (micIdle) micIdle.style.display = 'none';
        if (micStop) micStop.style.display = 'block';
        micBtn.classList.add('mic-recording');
        micBtn.title = 'Stop dictation';
      }
      function setMicIdle() {
        isListening = false;
        if (micIdle) micIdle.style.display = 'block';
        if (micStop) micStop.style.display = 'none';
        micBtn.classList.remove('mic-recording');
        micBtn.title = 'Voice dictation';
      }

      if (hasNativeSpeech) {
        // ── Path 1: Native macOS SFSpeechRecognizer (via Alice.app bridge) ──
        let preExisting = '';
        let finalText = '';
        
        window._nativeSpeech.onStart = () => { /* icon already set on click */ };

        window._nativeSpeech.onResult = (text, isFinal) => {
          const base = preExisting ? preExisting + ' ' : '';
          if (isFinal) {
            finalText = text;
            input.value = base + finalText;
          } else {
            input.value = base + text + ' …';
          }
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 160) + 'px';
        };

        window._nativeSpeech.onEnd = () => {
          setMicIdle();
          input.value = input.value.replace(/\\s*…$/, '').trim();
          input.focus();
        };

        window._nativeSpeech.onError = (error) => {
          console.warn('Native speech error:', error);
          setMicIdle();
        };

        micBtn.addEventListener('click', () => {
          if (isListening) {
            window._nativeSpeech.stop();
            setMicIdle();
            return;
          }
          preExisting = input.value;
          finalText = '';
          setMicRecording();
          window._nativeSpeech.start();
        });
      } else if (SpeechRecognition) {
        // ── Path 2: Web Speech API (Chrome/Safari) ──
        micBtn.addEventListener('click', () => {
          if (isListening) {
            recognition.stop();
            return;
          }

          recognition = new SpeechRecognition();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = 'en-US';

          const preExisting = input.value;
          let finalTranscript = '';

          recognition.onstart = () => { setMicRecording(); };

          recognition.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
              if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript + ' ';
              } else {
                interim += event.results[i][0].transcript;
              }
            }
            const base = preExisting ? preExisting + ' ' : '';
            input.value = base + finalTranscript + (interim ? interim + ' …' : '');
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 160) + 'px';
          };

          recognition.onend = () => {
            setMicIdle();
            input.value = input.value.replace(/\\s*…$/, '').trim();
            input.focus();
          };

          recognition.onerror = (event) => {
            console.warn('Speech recognition error:', event.error);
            setMicIdle();
          };

          recognition.start();
        });
      } else {
        // ── Path 3: getUserMedia + WAV recording + server transcription (Electron/menubar) ──
        let audioCtx = null;
        let sourceNode = null;
        let processorNode = null;
        let audioStream = null;
        let pcmChunks = [];

        function encodeWAV(samples, sampleRate) {
          const buffer = new ArrayBuffer(44 + samples.length * 2);
          const view = new DataView(buffer);
          function writeStr(offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
          writeStr(0, 'RIFF');
          view.setUint32(4, 36 + samples.length * 2, true);
          writeStr(8, 'WAVE');
          writeStr(12, 'fmt ');
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true); // PCM
          view.setUint16(22, 1, true); // mono
          view.setUint32(24, sampleRate, true);
          view.setUint32(28, sampleRate * 2, true); // byte rate
          view.setUint16(32, 2, true); // block align
          view.setUint16(34, 16, true); // bits per sample
          writeStr(36, 'data');
          view.setUint32(40, samples.length * 2, true);
          for (let i = 0; i < samples.length; i++) {
            const s = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
          }
          return new Blob([buffer], { type: 'audio/wav' });
        }

        micBtn.addEventListener('click', async () => {
          if (isListening) {
            // Stop recording
            if (processorNode) processorNode.disconnect();
            if (sourceNode) sourceNode.disconnect();
            if (audioStream) audioStream.getTracks().forEach(t => t.stop());
            if (audioCtx) audioCtx.close();
            setMicIdle();

            if (pcmChunks.length === 0) return;

            const preExisting = micBtn._preExisting || '';
            const totalLen = pcmChunks.reduce((a, c) => a + c.length, 0);
            const merged = new Float32Array(totalLen);
            let offset = 0;
            for (const chunk of pcmChunks) { merged.set(chunk, offset); offset += chunk.length; }

            const wavBlob = encodeWAV(merged, 16000);
            input.value = preExisting + (preExisting ? ' ' : '') + '⏳ Transcribing…';

            try {
              const resp = await fetch('/api/transcribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: wavBlob
              });
              const data = await resp.json();
              if (data.text) {
                input.value = preExisting + (preExisting ? ' ' : '') + data.text;
              } else {
                input.value = preExisting;
                console.warn('Transcription returned no text:', data);
              }
            } catch (err) {
              input.value = preExisting;
              console.warn('Transcription failed:', err);
            }
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 160) + 'px';
            input.focus();
            return;
          }

          try {
            audioStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true } });
            pcmChunks = [];
            micBtn._preExisting = input.value;

            audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            sourceNode = audioCtx.createMediaStreamSource(audioStream);
            processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

            processorNode.onaudioprocess = (e) => {
              const data = e.inputBuffer.getChannelData(0);
              pcmChunks.push(new Float32Array(data));
            };

            sourceNode.connect(processorNode);
            processorNode.connect(audioCtx.destination);
            setMicRecording();
          } catch (err) {
            console.warn('Microphone access denied:', err);
            setMicIdle();
          }
        });
      }
    }



    // ── Sidebar ──────────────────────────
    const sidebar = document.getElementById('sidebar');
    const menuBtn = document.getElementById('menuBtn');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const sessionList = document.getElementById('sessionList');
    const sidebarNewChat = document.getElementById('sidebarNewChat');
    let currentSessionId = null;

    function toggleSidebar() {
      sidebar.classList.toggle('collapsed');
      sidebarOverlay.classList.toggle('active');
      if (!sidebar.classList.contains('collapsed')) loadSessions();
    }

    menuBtn.addEventListener('click', toggleSidebar);
    sidebarOverlay.addEventListener('click', toggleSidebar);

    // Click generated images to open full-size in new tab
    messages.addEventListener('click', (e) => {
      const img = e.target;
      if (img.tagName === 'IMG' && img.closest('.msg-content')) {
        window.open(img.src, '_blank');
      }
    });

    function showWelcome() {
      messages.innerHTML = \`
        <div class="welcome" id="welcome">
          <div class="welcome-icon"><img src="/alice-icon-512.png" alt="Alice" style="width:80px;height:80px;border-radius:50%"></div>
          <h2>Hi, I’m Alice</h2>
          <p>Your personal AI agent. I can write code, search the web, manage files, and much more.</p>
          <div class="suggestions">
            <button class="suggestion" data-msg="What tools do you have?"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/></svg> What can you do?</button>
            <button class="suggestion" data-msg="Show me the git status of this project"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg> Git status</button>
            <button class="suggestion" data-msg="Search my memory for recent topics"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18V5m3 8a4.17 4.17 0 0 1-3-4a4.17 4.17 0 0 1-3 4m8.598-6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/></svg> Search memory</button>
            <button class="suggestion" data-msg="Set a reminder in 5 minutes to take a break"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Set reminder</button>
          </div>
        </div>\`;
      bindSuggestions();
    }

    // New Chat
    async function startNewChat() {
      try {
        const res = await fetch('/api/sessions', { method: 'POST' });
        const data = await res.json();
        currentSessionId = data.sessionId;
        showChatView();
        showWelcome();
        loadSessions();
      } catch (err) {
        console.error('New chat failed:', err);
      }
    }
    sidebarNewChat.addEventListener('click', startNewChat);
    document.getElementById('newChatBtn').addEventListener('click', startNewChat);

    // Session search filtering
    document.getElementById('sessionSearch').addEventListener('input', (e) => {
      const query = e.target.value.trim().toLowerCase();
      if (!query) {
        // Show all items when search is cleared
        sessionList.querySelectorAll('.sidebar-item, .sidebar-group-label').forEach(el => el.style.display = '');
      } else {
        filterSessions(query);
      }
    });

    // Dashboard nav items
    const dashboardView = document.getElementById('dashboardView');
    function showChatView() {
      messages.style.display = '';
      document.querySelector('.input-wrapper').style.display = '';
      dashboardView.style.display = 'none';
    }
    function showDashboardView(html) {
      messages.style.display = 'none';
      document.querySelector('.input-wrapper').style.display = 'none';
      dashboardView.style.display = '';
      dashboardView.innerHTML = html;
    }

    async function loadDashboard(page) {
      if (page === 'tools') {
        const res = await fetch('/api/tools').then(r => r.json());
        let html = '<h2 style="color:var(--accent);margin-bottom:16px">Tools &amp; Plugins</h2>';

        // Search bar
        html += '<div style="margin-bottom:16px"><input id="tool-search" type="text" placeholder="Search tools..." style="width:100%;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);font-size:14px;outline:none" /></div>';

        // Categorize tools
        const categories = {};
        const catOrder = [];
        const catMap = {
          // Built-in file/system tools
          'read_file': '📁 File System', 'write_file': '📁 File System', 'edit_file': '📁 File System', 'list_directory': '📁 File System',
          'bash': '⚙️ System', 'web_search': '🌐 Web', 'web_fetch': '🌐 Web', 'read_pdf': '📄 Documents',
          'generate_image': '🎨 Creative', 'gemini_code': '🎨 Creative',
          // Browser
          'browse_page': '🌐 Browser', 'screenshot': '🌐 Browser', 'click_element': '🌐 Browser', 'type_text': '🌐 Browser', 'browser_clear_data': '🌐 Browser',
          // Memory
          'search_memory': '🧠 Memory & Search', 'semantic_search': '🧠 Memory & Search',
          // Scheduling
          'set_reminder': '⏰ Scheduling', 'cancel_reminder': '⏰ Scheduling', 'list_reminders': '⏰ Scheduling',
          'create_cron_job': '⏰ Scheduling', 'list_cron_jobs': '⏰ Scheduling', 'delete_cron_job': '⏰ Scheduling',
          // Git
          'git_status': '📦 Git', 'git_diff': '📦 Git', 'git_commit': '📦 Git', 'git_log': '📦 Git', 'git_backup': '📦 Git',
          // Clipboard
          'clipboard_read': '📋 Clipboard', 'clipboard_write': '📋 Clipboard',
          // Canvas / UI
          'canvas': '🎨 Creative', 'get_location': '📍 Location', 'switch_persona': '👤 Persona',
          'install_skill': '🦀 Skills', 'watch_file': '⏰ Scheduling',
        };

        (res.tools || []).forEach(t => {
          let cat;
          if (catMap[t.name]) {
            cat = catMap[t.name];
          } else if (t.name.startsWith('mcp_')) {
            // Extract MCP server name: mcp_servername_toolname
            const parts = t.name.split('_');
            const serverName = parts.slice(1, -1).join('-') || parts[1] || 'unknown';
            // Try to get a clean name from the description prefix like [MCP:github]
            const desc = t.description || '';
            const mcpIdx = desc.indexOf('[MCP:');
            const cleanName = mcpIdx >= 0 ? desc.substring(mcpIdx + 5, desc.indexOf(']', mcpIdx)) : serverName;
            cat = '🔌 MCP: ' + cleanName;
          } else {
            cat = '⚙️ Other';
          }
          if (!categories[cat]) { categories[cat] = []; catOrder.push(cat); }
          categories[cat].push(t);
        });

        // Sort: built-in first, MCP last
        const sortedCats = catOrder.filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => {
          const aIsMcp = a.includes('MCP');
          const bIsMcp = b.includes('MCP');
          if (aIsMcp && !bIsMcp) return 1;
          if (!aIsMcp && bIsMcp) return -1;
          return 0;
        });

        sortedCats.forEach((cat, idx) => {
          const tools = categories[cat];
          const isCollapsed = cat.includes('MCP');
          html += '<div class="tool-group" data-group="' + cat + '">';
          html += '<div class="tool-group-header" data-idx="' + idx + '" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:8px;cursor:pointer;user-select:none">';
          html += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:14px;font-weight:600;color:var(--text-primary)">' + cat + '</span><span style="background:var(--accent);color:#000;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px">' + tools.length + '</span></div>';
          html += '<span class="tool-chevron" id="chev-' + idx + '" style="color:var(--text-tertiary);font-size:12px;transition:transform 0.2s">' + (isCollapsed ? '▶' : '▼') + '</span>';
          html += '</div>';
          html += '<div class="tool-group-body" id="tgb-' + idx + '" style="display:' + (isCollapsed ? 'none' : 'grid') + ';grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;margin-bottom:14px;padding-left:4px">';
          tools.forEach(t => {
            html += '<div class="tool-card" data-name="' + t.name + '" style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:10px;padding:12px 14px;border-left:3px solid var(--accent)">';
            html += '<div style="font-weight:500;color:var(--text-primary);margin-bottom:4px;font-size:13px">' + t.name + '</div>';
            const cleanDesc = (t.description || '').replace('[MCP:' + (t.description || '').split('[MCP:')[1]?.split(']')[0] + '] ', '').slice(0, 120);
            html += '<div style="font-size:12px;color:var(--text-secondary);line-height:1.4">' + cleanDesc + '</div></div>';
          });
          html += '</div></div>';
        });

        showDashboardView(html);

        // Wire collapsible headers
        document.querySelectorAll('.tool-group-header').forEach(hdr => {
          hdr.addEventListener('click', () => {
            const idx = hdr.dataset.idx;
            const body = document.getElementById('tgb-' + idx);
            const chev = document.getElementById('chev-' + idx);
            if (body.style.display === 'none') {
              body.style.display = 'grid';
              chev.textContent = '▼';
            } else {
              body.style.display = 'none';
              chev.textContent = '▶';
            }
          });
        });

        // Wire search
        document.getElementById('tool-search')?.addEventListener('input', (e) => {
          const q = e.target.value.toLowerCase();
          document.querySelectorAll('.tool-card').forEach(card => {
            const name = card.dataset.name || '';
            const desc = card.textContent || '';
            card.style.display = (name.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) ? '' : 'none';
          });
          // Show groups that have visible cards
          document.querySelectorAll('.tool-group').forEach(grp => {
            const visibleCards = grp.querySelectorAll('.tool-card[style*="display: none"]');
            const allCards = grp.querySelectorAll('.tool-card');
            const body = grp.querySelector('.tool-group-body');
            if (q && body) body.style.display = 'grid';
            grp.style.display = (visibleCards.length === allCards.length && q) ? 'none' : '';
          });
        });
      } else if (page === 'memory') {
        const res = await fetch('/api/memory').then(r => r.json());
        let html = '<h2 style="color:var(--accent);margin-bottom:12px">Memory</h2>';
        html += '<input id="mem-search" type="text" placeholder="Search memory items..." style="width:100%;padding:9px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);font-size:13px;outline:none;margin-bottom:14px" />';

        // Tab bar
        html += '<div id="mem-tabs" style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap">';
        res.files.forEach((f, i) => {
          const isItems = f.type === 'items';
          const count = isItems ? f.sections.reduce((s, sec) => s + sec.items.length, 0) : 0;
          const badge = isItems && count > 0 ? ' <span style="background:var(--accent);color:#131314;border-radius:10px;padding:1px 7px;font-size:10px;margin-left:4px;font-weight:600">' + count + '</span>' : '';
          html += '<button class="mem-tab" data-tab="' + i + '" style="'
            + 'background:' + (i === 0 ? 'var(--accent)' : 'var(--surface)') + ';'
            + 'color:' + (i === 0 ? '#131314' : 'var(--text-secondary)') + ';'
            + 'border:1px solid ' + (i === 0 ? 'var(--accent)' : 'var(--border)') + ';'
            + 'padding:6px 16px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:500;'
            + 'letter-spacing:0.5px;text-transform:uppercase;font-family:var(--font);'
            + 'transition:all var(--duration-short) var(--motion-standard)'
            + '">' + f.name + badge + '</button>';
        });
        html += '</div>';

        // Tab content panels
        res.files.forEach((f, i) => {
          html += '<div class="mem-panel" data-panel="' + i + '" style="display:' + (i === 0 ? 'block' : 'none') + '">';

          if (f.type === 'items') {
            // DB-backed items view
            if (f.sections.length === 0 || f.sections.every(s => s.items.length === 0)) {
              html += '<div style="color:var(--text-tertiary);font-size:14px;padding:24px;text-align:center;background:var(--surface);border-radius:12px;border:1px solid var(--border)">No items yet. Add one below or ask Alice to learn something new.</div>';
            } else {
              f.sections.forEach(sec => {
                if (sec.heading) {
                  html += '<div style="font-size:11px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:1px;margin:16px 0 8px;padding-left:4px">' + sec.heading + '</div>';
                }
                sec.items.forEach(item => {
                  html += '<div class="mem-item" data-id="' + item.id + '" style="'
                    + 'display:flex;align-items:flex-start;gap:12px;padding:12px 16px;'
                    + 'background:var(--surface);border:1px solid var(--border);border-radius:10px;'
                    + 'margin-bottom:6px;transition:all var(--duration-medium) var(--motion-standard);'
                    + 'overflow:hidden;max-height:200px">'
                    + '<div style="flex:1;font-size:13px;color:var(--text-primary);line-height:1.5;padding-top:1px">' + item.content + '</div>'
                    + '<button class="mem-delete" data-id="' + item.id + '" title="Remove" style="'
                    + 'background:none;border:none;color:var(--text-tertiary);cursor:pointer;'
                    + 'padding:4px;border-radius:6px;flex-shrink:0;display:flex;align-items:center;'
                    + 'transition:all var(--duration-short) var(--motion-standard)'
                    + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>'
                    + '</div>';
                });
              });
            }

            // Add item form
            const fileKey = f.name === 'USER' ? 'user' : 'memory';
            html += '<div style="margin-top:12px;display:flex;gap:8px;align-items:center">';
            html += '<input class="mem-add-input" data-file="' + fileKey + '" placeholder="Add a new memory item..." style="'
              + 'flex:1;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);'
              + 'border-radius:10px;padding:10px 14px;font-family:var(--font);font-size:13px;'
              + 'outline:none;transition:border-color var(--duration-short) var(--motion-standard)">';
            html += '<select class="mem-add-section" data-file="' + fileKey + '" style="'
              + 'background:var(--bg-tertiary);color:var(--text-secondary);border:1px solid var(--border);'
              + 'border-radius:10px;padding:10px 12px;font-family:var(--font);font-size:12px;cursor:pointer">';
            html += '<option value="">No section</option>';
            f.sections.forEach(sec => {
              if (sec.heading) html += '<option value="' + sec.heading + '">' + sec.heading + '</option>';
            });
            html += '</select>';
            html += '<button class="mem-add-btn" data-file="' + fileKey + '" style="'
              + 'background:var(--accent);color:#131314;border:none;padding:10px 18px;border-radius:10px;'
              + 'cursor:pointer;font-size:12px;font-weight:500;font-family:var(--font);white-space:nowrap;'
              + 'transition:opacity var(--duration-short) var(--motion-standard)">Add</button>';
            html += '</div>';

          } else {
            // Raw textarea editor (IDENTITY, SOUL, HEARTBEAT)
            html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
            html += '<span style="font-weight:500;color:var(--text-primary);text-transform:uppercase;font-size:12px;letter-spacing:0.5px">' + f.name + '</span>';
            html += '<button class="save-mem-btn" data-name="' + f.name + '" style="background:var(--accent);color:#131314;border:none;padding:4px 14px;border-radius:8px;cursor:pointer;font-size:12px">Save</button></div>';
            html += '<textarea class="mem-editor" data-name="' + f.name + '" style="width:100%;min-height:200px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:var(--font-mono);font-size:13px;resize:vertical;line-height:1.5">' + (f.content || '') + '</textarea></div>';
          }

          html += '</div>';
        });

        showDashboardView(html);

        // Tab switching
        dashboardView.querySelectorAll('.mem-tab').forEach(tab => {
          tab.addEventListener('click', () => {
            dashboardView.querySelectorAll('.mem-tab').forEach(t => {
              t.style.background = 'var(--surface)';
              t.style.color = 'var(--text-secondary)';
              t.style.borderColor = 'var(--border)';
            });
            tab.style.background = 'var(--accent)';
            tab.style.color = '#131314';
            tab.style.borderColor = 'var(--accent)';
            dashboardView.querySelectorAll('.mem-panel').forEach(p => { p.style.display = 'none'; });
            const panel = dashboardView.querySelector('.mem-panel[data-panel="' + tab.dataset.tab + '"]');
            if (panel) panel.style.display = 'block';
          });
        });

        // Delete buttons — animate then remove
        dashboardView.querySelectorAll('.mem-delete').forEach(btn => {
          btn.addEventListener('mouseenter', () => { btn.style.color = 'var(--error)'; btn.style.background = 'rgba(242,184,181,0.1)'; });
          btn.addEventListener('mouseleave', () => { btn.style.color = 'var(--text-tertiary)'; btn.style.background = 'none'; });
          btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const row = btn.closest('.mem-item');
            if (!row) return;
            // Animate out
            row.style.opacity = '0';
            row.style.maxHeight = '0';
            row.style.padding = '0 16px';
            row.style.marginBottom = '0';
            row.style.borderColor = 'transparent';
            await fetch('/api/memory/items/' + id, { method: 'DELETE' });
            setTimeout(() => { row.remove(); }, 300);
          });
        });

        // Add item
        dashboardView.querySelectorAll('.mem-add-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const file = btn.dataset.file;
            const input = dashboardView.querySelector('.mem-add-input[data-file="' + file + '"]');
            const sectionSelect = dashboardView.querySelector('.mem-add-section[data-file="' + file + '"]');
            const content = input?.value?.trim();
            if (!content) return;
            const section = sectionSelect?.value || '';
            await fetch('/api/memory/items', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ file, section, content }),
            });
            input.value = '';
            // Reload the memory page to show the new item
            loadDashboard('memory');
          });
        });

        // Enter key to add
        dashboardView.querySelectorAll('.mem-add-input').forEach(input => {
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              const file = input.dataset.file;
              dashboardView.querySelector('.mem-add-btn[data-file="' + file + '"]')?.click();
            }
          });
          // Focus styles
          input.addEventListener('focus', () => { input.style.borderColor = 'var(--accent)'; });
          input.addEventListener('blur', () => { input.style.borderColor = 'var(--border)'; });
        });

        // Raw editor save buttons
        dashboardView.querySelectorAll('.save-mem-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const ta = dashboardView.querySelector('.mem-editor[data-name="' + name + '"]');
            await fetch('/api/memory/' + name, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({content: ta.value}) });
            btn.textContent = 'Saved!';
            setTimeout(() => { btn.textContent = 'Save'; }, 2000);
          });
        });

        // Memory search filter
        document.getElementById('mem-search')?.addEventListener('input', (e) => {
          const q = e.target.value.toLowerCase();
          dashboardView.querySelectorAll('.mem-item').forEach(item => {
            const text = item.textContent.toLowerCase();
            item.style.display = (!q || text.includes(q)) ? '' : 'none';
          });
        });
      } else if (page === 'reminders') {
        const res = await fetch('/api/reminders').then(r => r.json());
        let html = '<h2 style="color:var(--accent);margin-bottom:16px">Reminders</h2>';

        // Create new reminder form
        html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 20px;margin-bottom:16px">';
        html += '<div style="font-weight:600;color:var(--text-primary);margin-bottom:12px;font-size:14px">+ New Reminder</div>';
        html += '<div style="display:grid;grid-template-columns:1fr 200px auto;gap:10px;align-items:end">';
        html += '<div><div style="font-size:12px;color:var(--text-tertiary);margin-bottom:4px">Message</div><input id="rem-msg" type="text" placeholder="Take a break, check emails..." style="width:100%;padding:10px 12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:13px;outline:none" /></div>';
        html += '<div><div style="font-size:12px;color:var(--text-tertiary);margin-bottom:4px">Schedule</div><input id="rem-schedule" type="text" placeholder="in 5m, in 2h, 0 9 * * *" style="width:100%;padding:10px 12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:13px;outline:none" /></div>';
        html += '<button id="rem-create-btn" style="background:var(--accent);color:#000;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;height:40px">Create</button>';
        html += '</div></div>';

        // Existing reminders list
        if (res.reminders.length === 0) {
          html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px;text-align:center"><p style="color:var(--text-tertiary);margin:0">No active reminders. Create one above or ask Alice!</p></div>';
        } else {
          html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden">';
          res.reminders.forEach((r, i) => {
            const borderTop = i > 0 ? 'border-top:1px solid var(--border);' : '';
            html += '<div style="padding:14px 20px;display:flex;align-items:center;justify-content:space-between;' + borderTop + '">';
            html += '<div style="display:flex;align-items:center;gap:10px">';
            html += '<div style="width:8px;height:8px;border-radius:50%;background:#4ade80"></div>';
            html += '<div><div style="color:var(--text-primary);font-weight:500;font-size:14px">' + (r.message || r.id) + '</div>';
            if (r.cron) {
              html += '<div style="display:flex;align-items:center;gap:6px;margin-top:3px"><span style="background:var(--accent);color:#000;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px">CRON</span><span style="color:var(--text-tertiary);font-size:12px">' + r.cron + '</span></div>';
            } else {
              html += '<div style="margin-top:3px"><span style="background:#60a5fa;color:#000;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px">ONE-SHOT</span></div>';
            }
            html += '</div></div>';
            html += '<button class="cancel-rem-btn" data-id="' + r.id + '" style="background:#e5393522;color:#e53935;border:1px solid #e5393544;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:500">Delete</button>';
            html += '</div>';
          });
          html += '</div>';
        }
        showDashboardView(html);

        // Wire create button
        document.getElementById('rem-create-btn')?.addEventListener('click', async () => {
          const msg = document.getElementById('rem-msg').value.trim();
          const schedule = document.getElementById('rem-schedule').value.trim();
          if (!msg || !schedule) return;
          const btn = document.getElementById('rem-create-btn');
          btn.textContent = '⏳';
          // Use Alice's chat endpoint to set the reminder naturally
          await fetch('/api/chat', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ message: 'Set a reminder ' + schedule + ': ' + msg }) });
          btn.textContent = '✅ Created!';
          setTimeout(() => loadDashboard('reminders'), 1000);
        });

        // Wire delete buttons
        dashboardView.querySelectorAll('.cancel-rem-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            await fetch('/api/reminders/' + btn.dataset.id, { method: 'DELETE' });
            loadDashboard('reminders');
          });
        });

      } else if (page === 'command_center') {
        const [stats, cronData, connData] = await Promise.all([
          fetch('/api/stats').then(r => r.json()),
          fetch('/api/cron-jobs').then(r => r.json()).catch(() => ({ jobs: [] })),
          fetch('/api/connections').then(r => r.json()).catch(() => ({ connections: [] })),
        ]);
        const upH = Math.floor(stats.uptime / 3600);
        const upM = Math.floor((stats.uptime % 3600) / 60);
        const uptimeStr = upH > 0 ? upH + 'h ' + upM + 'm' : upM + 'm';
        const topTools = Object.entries(stats.toolsUsed || {}).sort((a,b) => b[1] - a[1]).slice(0,5);
        const onlineCount = (connData.connections || []).filter(c => c.status === 'online').length;
        const totalConns = (connData.connections || []).length;
        const cronJobs = cronData.jobs || [];

        let html = '<h2 style="color:var(--accent);margin-bottom:20px">Command Center</h2>';

        // ── Stat cards row ──
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px">';
        const cards = [
          { label: 'Uptime', value: uptimeStr, color: '#4ade80' },
          { label: 'Messages', value: stats.messagesTotal, color: '#60a5fa' },
          { label: 'Tool Calls', value: stats.toolCalls, color: '#c084fc' },
          { label: 'API Calls', value: stats.apiCalls || 0, color: '#f472b6' },
          { label: 'Sessions', value: stats.sessionCount, color: '#facc15' },
          { label: 'Active Model', value: (stats.activeModel || '').split('/').pop(), color: '#fb923c' },
        ];
        cards.forEach(c => {
          html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;position:relative;overflow:hidden">';
          html += '<div style="position:absolute;top:-10px;right:-10px;width:50px;height:50px;border-radius:50%;background:' + c.color + '12"></div>';
          html += '<div style="font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px">' + c.label + '</div>';
          html += '<div style="font-size:20px;font-weight:700;color:' + c.color + '">' + c.value + '</div>';
          html += '</div>';
        });
        html += '</div>';

        // ── Two column layout: System Health + Quick Actions ──
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px">';

        // System Health
        html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px">';
        html += '<div style="font-weight:600;color:var(--text-primary);margin-bottom:12px;font-size:14px;display:flex;align-items:center;gap:8px"><span style="font-size:16px">🟢</span> System Health</div>';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px">';
        html += '<div style="color:var(--text-secondary)">Provider: <span style="color:var(--text-primary);font-weight:500">' + stats.activeProvider + '</span></div>';
        html += '<div style="color:var(--text-secondary)">Fallback: <span style="color:' + (stats.usingFallback ? '#f87171' : '#4ade80') + ';font-weight:500">' + (stats.usingFallback ? 'Active' : 'Standby') + '</span></div>';
        html += '<div style="color:var(--text-secondary)">Connections: <span style="color:' + (onlineCount === totalConns ? '#4ade80' : '#facc15') + ';font-weight:500">' + onlineCount + '/' + totalConns + ' online</span></div>';
        html += '<div style="color:var(--text-secondary)">Cron Jobs: <span style="color:var(--text-primary);font-weight:500">' + cronJobs.length + ' active</span></div>';
        html += '</div></div>';

        // Quick Actions
        html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px">';
        html += '<div style="font-weight:600;color:var(--text-primary);margin-bottom:12px;font-size:14px;display:flex;align-items:center;gap:8px"><span style="font-size:16px">⚡</span> Quick Actions</div>';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
        const actions = [
          { label: '☀️ Run Briefing', id: 'qa-briefing' },
          { label: '💓 Heartbeat', id: 'qa-heartbeat' },
          { label: '📦 Git Backup', id: 'qa-backup' },
          { label: '🔄 Refresh', id: 'qa-refresh' },
        ];
        actions.forEach(a => {
          html += '<button id="' + a.id + '" class="qa-btn" style="background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:10px;padding:10px 14px;cursor:pointer;font-size:13px;font-weight:500;transition:all 0.2s;text-align:left">' + a.label + '</button>';
        });
        html += '</div></div>';
        html += '</div>';

        // ── Two column: Cron Jobs + Top Tools ──
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">';

        // Scheduled Jobs
        html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px">';
        html += '<div style="font-weight:600;color:var(--text-primary);margin-bottom:12px;font-size:14px;display:flex;align-items:center;gap:8px"><span style="font-size:16px">📅</span> Scheduled Jobs</div>';
        if (cronJobs.length === 0) {
          html += '<div style="color:var(--text-tertiary);font-size:13px">No scheduled jobs.</div>';
        } else {
          cronJobs.forEach(j => {
            const isEnabled = j.enabled !== false;
            const statusDot = isEnabled ? '#4ade80' : '#666';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">';
            html += '<div style="display:flex;align-items:center;gap:8px">';
            html += '<div style="width:8px;height:8px;border-radius:50%;background:' + statusDot + '"></div>';
            html += '<div><div style="font-size:13px;color:var(--text-primary);font-weight:500">' + (j.name || j.id) + '</div>';
            html += '<div style="font-size:11px;color:var(--text-tertiary)">' + (j.cron || '') + (j.lastRun ? ' · Last: ' + new Date(j.lastRun).toLocaleTimeString() : '') + '</div></div>';
            html += '</div>';
            html += '<button class="cron-run-btn" data-id="' + j.id + '" style="background:var(--accent);color:#000;border:none;border-radius:8px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600">Run</button>';
            html += '</div>';
          });
        }
        html += '</div>';

        // Top Tools
        html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px">';
        html += '<div style="font-weight:600;color:var(--text-primary);margin-bottom:12px;font-size:14px;display:flex;align-items:center;gap:8px"><span style="font-size:16px">🔧</span> Top Tools This Session</div>';
        if (topTools.length === 0) {
          html += '<div style="color:var(--text-tertiary);font-size:13px">No tools used yet this session.</div>';
        } else {
          topTools.forEach(([name, count]) => {
            const maxC = topTools[0][1];
            const pct = Math.round((count / maxC) * 100);
            html += '<div style="margin-bottom:10px">';
            html += '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px"><span style="color:var(--text-secondary)">' + name + '</span><span style="color:var(--text-primary);font-weight:500">' + count + '</span></div>';
            html += '<div style="height:4px;background:var(--bg-tertiary);border-radius:2px"><div style="height:100%;width:' + pct + '%;background:var(--accent);border-radius:2px;transition:width 0.3s"></div></div>';
            html += '</div>';
          });
        }
        html += '</div>';
        html += '</div>';

        showDashboardView(html);

        // Wire quick action buttons
        document.querySelectorAll('.qa-btn').forEach(btn => {
          btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--accent)'; btn.style.color = '#000'; });
          btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--bg-tertiary)'; btn.style.color = 'var(--text-primary)'; });
        });
        document.getElementById('qa-briefing')?.addEventListener('click', async (e) => {
          e.target.textContent = '⏳ Running...';
          await fetch('/api/cron-jobs/job_morning_brief/run', { method: 'POST' });
          e.target.textContent = '✅ Sent!';
          setTimeout(() => { e.target.textContent = '☀️ Run Briefing'; }, 2000);
        });
        document.getElementById('qa-heartbeat')?.addEventListener('click', async (e) => {
          e.target.textContent = '⏳ Running...';
          await fetch('/api/heartbeat/trigger', { method: 'POST' }).catch(() => {});
          e.target.textContent = '✅ Triggered!';
          setTimeout(() => { e.target.textContent = '💓 Heartbeat'; }, 2000);
        });
        document.getElementById('qa-backup')?.addEventListener('click', async (e) => {
          e.target.textContent = '⏳ Backing up...';
          await fetch('/api/chat', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ message: 'Backup everything to git: commit all changes and push to origin' }) });
          e.target.textContent = '✅ Started!';
          setTimeout(() => { e.target.textContent = '📦 Git Backup'; }, 2000);
        });
        document.getElementById('qa-refresh')?.addEventListener('click', () => loadDashboard('command_center'));

        // Wire cron run buttons
        document.querySelectorAll('.cron-run-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            btn.textContent = '⏳';
            await fetch('/api/cron-jobs/' + btn.dataset.id + '/run', { method: 'POST' });
            btn.textContent = '✅';
            setTimeout(() => { btn.textContent = 'Run'; }, 2000);
          });
        });

      } else if (page === 'connections') {
        const [data, toolsData] = await Promise.all([
          fetch('/api/connections').then(r => r.json()),
          fetch('/api/tools').then(r => r.json()).catch(() => ({ tools: [] })),
        ]);

        // Count tools per MCP server
        const mcpToolCounts = {};
        (toolsData.tools || []).forEach(t => {
          if (t.name.startsWith('mcp_')) {
            const desc = t.description || '';
            const mcpIdx = desc.indexOf('[MCP:');
            const serverName = mcpIdx >= 0 ? 'MCP: ' + desc.substring(mcpIdx + 5, desc.indexOf(']', mcpIdx)) : t.name.split('_').slice(1, -1).join('-');
            mcpToolCounts[serverName] = (mcpToolCounts[serverName] || 0) + 1;
          }
        });

        let html = '<h2 style="color:var(--accent);margin-bottom:20px">Connections</h2>';

        // Separate providers and MCP servers
        const providers = (data.connections || []).filter(c => !c.name.startsWith('MCP:'));
        const mcpServers = (data.connections || []).filter(c => c.name.startsWith('MCP:'));

        // Providers section
        if (providers.length > 0) {
          html += '<div style="font-weight:600;color:var(--text-primary);margin-bottom:10px;font-size:13px;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-tertiary)">Providers</div>';
          html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-bottom:24px">';
          providers.forEach(c => {
            const isOnline = c.status === 'online';
            const dotColor = isOnline ? '#4ade80' : '#f87171';
            html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;border-left:3px solid ' + dotColor + '">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
            html += '<div style="display:flex;align-items:center;gap:8px"><div style="width:8px;height:8px;border-radius:50%;background:' + dotColor + ';box-shadow:0 0 6px ' + dotColor + '44"></div><span style="font-weight:600;color:var(--text-primary);font-size:14px">' + c.name + '</span></div>';
            html += '<span style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:' + dotColor + ';font-weight:600">' + c.status + '</span>';
            html += '</div>';
            html += '<div style="font-size:12px;color:var(--text-secondary);line-height:1.4">' + c.detail + '</div>';
            html += '</div>';
          });
          html += '</div>';
        }

        // MCP Servers section
        if (mcpServers.length > 0) {
          html += '<div style="font-weight:600;color:var(--text-primary);margin-bottom:10px;font-size:13px;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-tertiary)">MCP Servers</div>';
          html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">';
          mcpServers.forEach(c => {
            const isOnline = c.status === 'online';
            const dotColor = isOnline ? '#4ade80' : '#f87171';
            const serverKey = c.name.replace('MCP: ', '');
            const toolCount = mcpToolCounts[c.name] || mcpToolCounts['MCP: ' + serverKey] || 0;
            html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;border-left:3px solid ' + dotColor + '">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
            html += '<div style="display:flex;align-items:center;gap:8px"><div style="width:8px;height:8px;border-radius:50%;background:' + dotColor + ';box-shadow:0 0 6px ' + dotColor + '44"></div><span style="font-weight:600;color:var(--text-primary);font-size:14px">' + c.name + '</span></div>';
            html += '<div style="display:flex;align-items:center;gap:6px">';
            if (toolCount > 0) html += '<span style="background:var(--accent);color:#000;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px">' + toolCount + ' tools</span>';
            html += '<span style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:' + dotColor + ';font-weight:600">' + c.status + '</span>';
            html += '</div></div>';
            html += '<div style="font-size:12px;color:var(--text-secondary);line-height:1.4">' + c.detail + '</div>';
            html += '</div>';
          });
          html += '</div>';
        }

        showDashboardView(html);

      } else if (page === 'settings') {
        const [data, modelsData] = await Promise.all([
          fetch('/api/settings').then(r => r.json()),
          fetch('/api/models').then(r => r.json()).catch(() => ({ models: [], active: {} })),
        ]);
        let html = '<h2 style="color:var(--accent);margin-bottom:20px">Settings</h2>';

        // Model selector + Config
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">';

        // Model Selector
        html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px">';
        html += '<div style="font-weight:600;color:var(--text-primary);margin-bottom:12px;font-size:14px;display:flex;align-items:center;gap:8px"><span style="font-size:16px">🤖</span> Active Model</div>';
        const activeModel = (modelsData.active || {}).model || data.config?.model || '';
        const activeProvider = (modelsData.active || {}).provider || data.config?.provider || '';
        html += '<div style="margin-bottom:10px"><div style="font-size:12px;color:var(--text-tertiary);margin-bottom:4px">Provider</div><div style="font-size:14px;color:var(--text-primary);font-weight:500">' + activeProvider + '</div></div>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:4px">Model</div>';
        html += '<div style="display:flex;gap:8px;align-items:center">';
        html += '<select id="model-select" style="flex:1;padding:10px 12px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:13px;outline:none">';
        const models = modelsData.models || [];
        // Group by provider
        const groupedModels = {};
        models.forEach(m => {
          const provider = m.provider || 'unknown';
          if (!groupedModels[provider]) groupedModels[provider] = [];
          groupedModels[provider].push(m);
        });
        Object.entries(groupedModels).forEach(([provider, provModels]) => {
          html += '<optgroup label="' + provider + '">';
          provModels.forEach(m => {
            const modelId = m.id || m.model || m.name || '';
            const selected = modelId === activeModel ? ' selected' : '';
            html += '<option value="' + provider + '::' + modelId + '"' + selected + '>' + modelId + '</option>';
          });
          html += '</optgroup>';
        });
        html += '</select>';
        html += '<button id="switch-model-btn" style="background:var(--accent);color:#000;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap">Switch</button>';
        html += '</div></div>';

        // Config Summary
        html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px">';
        html += '<div style="font-weight:600;color:var(--text-primary);margin-bottom:12px;font-size:14px;display:flex;align-items:center;gap:8px"><span style="font-size:16px">⚙️</span> Configuration</div>';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">';
        const configItems = [
          { label: 'Memory Dir', value: data.config?.memoryDir || '' },
          { label: 'Gateway Port', value: data.config?.gatewayPort || '' },
          { label: 'Heartbeat', value: data.config?.heartbeatEnabled ? '✅ Every ' + (data.config?.heartbeatInterval || 30) + 'm' : '❌ Disabled' },
          { label: 'Fallback', value: activeProvider === 'gemini' ? 'Ollama' : 'Gemini' },
        ];
        configItems.forEach(c => {
          html += '<div style="color:var(--text-secondary)">' + c.label + ': <span style="color:var(--text-primary);font-weight:500">' + c.value + '</span></div>';
        });
        html += '</div></div>';
        html += '</div>';

        // Soul editor
        html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin-bottom:16px">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">';
        html += '<div style="font-weight:600;color:var(--text-primary);font-size:14px">Personality (SOUL.md)</div>';
        html += '<button id="saveSoulBtn" style="background:var(--accent);color:#131314;border:none;padding:6px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500">Save</button>';
        html += '</div>';
        html += '<textarea id="soulEditor" style="width:100%;min-height:160px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:12px;font-family:var(--font);font-size:13px;resize:vertical;line-height:1.6">' + (data.soul || '') + '</textarea>';
        html += '</div>';

        // Identity editor
        html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">';
        html += '<div style="font-weight:600;color:var(--text-primary);font-size:14px">Identity (IDENTITY.md)</div>';
        html += '<button id="saveIdentityBtn" style="background:var(--accent);color:#131314;border:none;padding:6px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500">Save</button>';
        html += '</div>';
        html += '<textarea id="identityEditor" style="width:100%;min-height:160px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:12px;font-family:var(--font);font-size:13px;resize:vertical;line-height:1.6">' + (data.identity || '') + '</textarea>';
        html += '</div>';

        showDashboardView(html);

        // Wire model switch button
        document.getElementById('switch-model-btn')?.addEventListener('click', async () => {
          const val = document.getElementById('model-select').value;
          const [provider, model] = val.split('::');
          const btn = document.getElementById('switch-model-btn');
          btn.textContent = '⏳';
          await fetch('/api/models/switch', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ provider, model }) });
          btn.textContent = '✅ Switched!';
          setTimeout(() => { btn.textContent = 'Switch'; loadDashboard('settings'); }, 1500);
        });

        // Save handlers
        document.getElementById('saveSoulBtn').addEventListener('click', async () => {
          const btn = document.getElementById('saveSoulBtn');
          await fetch('/api/settings/soul', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({content: document.getElementById('soulEditor').value}) });
          btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save'; }, 2000);
        });
        document.getElementById('saveIdentityBtn').addEventListener('click', async () => {
          const btn = document.getElementById('saveIdentityBtn');
          await fetch('/api/settings/identity', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({content: document.getElementById('identityEditor').value}) });
          btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save'; }, 2000);
        });

      } else if (page === 'personas') {
        const data = await fetch('/api/personas').then(r => r.json());
        const personas = data.personas || [];
        let html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">';
        html += '<h2 style="color:var(--accent);margin:0">Personas</h2>';
        html += '<button id="createPersonaBtn" style="background:var(--accent);color:#131314;border:none;padding:8px 18px;border-radius:10px;cursor:pointer;font-size:13px;font-weight:600">+ New Persona</button>';
        html += '</div>';
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">';
        personas.forEach(p => {
          const borderColor = p.isActive ? 'var(--accent)' : 'var(--border)';
          const glowStyle = p.isActive ? ';box-shadow:0 0 12px rgba(138,180,248,0.15)' : '';
          html += '<div class="persona-card" data-id="' + p.id + '" style="background:var(--surface);border:2px solid ' + borderColor + ';border-radius:14px;padding:18px 20px;cursor:pointer;transition:all 0.2s' + glowStyle + '">';
          html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
          html += '<div style="font-weight:600;color:var(--text-primary);font-size:15px">' + p.name + '</div>';
          html += '<div style="display:flex;gap:6px;align-items:center">';
          if (p.isActive) {
            html += '<span style="font-size:11px;background:var(--accent);color:#131314;padding:2px 8px;border-radius:6px;font-weight:600">ACTIVE</span>';
          }
          if (!p.isDefault) {
            html += '<button class="edit-persona-btn" data-id="' + p.id + '" style="background:none;border:1px solid var(--border);color:var(--text-secondary);padding:3px 8px;border-radius:6px;cursor:pointer;font-size:11px">Edit</button>';
            html += '<button class="del-persona-btn" data-id="' + p.id + '" style="background:none;border:1px solid #f87171;color:#f87171;padding:3px 8px;border-radius:6px;cursor:pointer;font-size:11px">Del</button>';
          } else {
            html += '<span style="font-size:11px;color:var(--text-tertiary)">Default</span>';
          }
          html += '</div></div>';
          html += '<div style="font-size:13px;color:var(--text-secondary);line-height:1.5">' + (p.description || 'No description') + '</div>';
          html += '</div>';
        });
        html += '</div>';

        // Create/Edit modal (hidden by default)
        html += '<div id="personaModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:1000;align-items:center;justify-content:center">';
        html += '<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:16px;padding:24px;width:90%;max-width:520px;max-height:90vh;overflow-y:auto">';
        html += '<h3 id="modalTitle" style="color:var(--accent);margin:0 0 16px">Create Persona</h3>';
        html += '<input id="pName" placeholder="Name" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text-primary);font-size:14px;margin-bottom:10px;box-sizing:border-box" />';
        html += '<input id="pDesc" placeholder="Short description" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text-primary);font-size:14px;margin-bottom:10px;box-sizing:border-box" />';
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:4px">Personality (Soul)</div>';
        html += '<textarea id="pSoul" placeholder="Define the personality traits, values, and communication style..." style="width:100%;min-height:100px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:13px;resize:vertical;line-height:1.5;box-sizing:border-box;margin-bottom:10px"></textarea>';
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:4px">Identity (Capabilities)</div>';
        html += '<textarea id="pIdentity" placeholder="Define the identity, capabilities, and role..." style="width:100%;min-height:100px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:13px;resize:vertical;line-height:1.5;box-sizing:border-box;margin-bottom:14px"></textarea>';
        html += '<div style="display:flex;gap:10px;justify-content:flex-end">';
        html += '<button id="cancelModal" style="background:var(--surface);color:var(--text-secondary);border:1px solid var(--border);padding:8px 18px;border-radius:8px;cursor:pointer;font-size:13px">Cancel</button>';
        html += '<button id="saveModal" style="background:var(--accent);color:#131314;border:none;padding:8px 18px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600">Save</button>';
        html += '</div></div></div>';
        showDashboardView(html);

        // Modal logic
        let editingId = null;
        const modal = document.getElementById('personaModal');
        document.getElementById('createPersonaBtn').addEventListener('click', () => {
          editingId = null;
          document.getElementById('modalTitle').textContent = 'Create Persona';
          document.getElementById('pName').value = '';
          document.getElementById('pDesc').value = '';
          document.getElementById('pSoul').value = '';
          document.getElementById('pIdentity').value = '';
          modal.style.display = 'flex';
        });
        document.getElementById('cancelModal').addEventListener('click', () => { modal.style.display = 'none'; });
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

        document.getElementById('saveModal').addEventListener('click', async () => {
          const name = document.getElementById('pName').value.trim();
          if (!name) return;
          const body = {
            name,
            description: document.getElementById('pDesc').value,
            soul: document.getElementById('pSoul').value,
            identity: document.getElementById('pIdentity').value,
          };
          if (editingId) {
            await fetch('/api/personas/' + editingId, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
          } else {
            await fetch('/api/personas', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
          }
          modal.style.display = 'none';
          loadDashboard('personas');
        });

        // Activate on card click
        dashboardView.querySelectorAll('.persona-card').forEach(card => {
          card.addEventListener('click', async (e) => {
            if (e.target.closest('.edit-persona-btn') || e.target.closest('.del-persona-btn')) return;
            await fetch('/api/personas/' + card.dataset.id + '/activate', { method: 'POST' });
            loadDashboard('personas');
          });
        });

        // Edit buttons
        dashboardView.querySelectorAll('.edit-persona-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const p = personas.find(x => x.id === btn.dataset.id);
            if (!p) return;
            editingId = p.id;
            document.getElementById('modalTitle').textContent = 'Edit Persona';
            document.getElementById('pName').value = p.name;
            document.getElementById('pDesc').value = p.description || '';
            document.getElementById('pSoul').value = p.soulContent || '';
            document.getElementById('pIdentity').value = p.identityContent || '';
            modal.style.display = 'flex';
          });
        });

        // Delete buttons
        dashboardView.querySelectorAll('.del-persona-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (confirm('Delete this persona?')) {
              await fetch('/api/personas/' + btn.dataset.id, { method: 'DELETE' });
              loadDashboard('personas');
            }
          });
        });
      }
    }

    document.querySelectorAll('.sidebar-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const page = item.dataset.page;
        loadDashboard(page);
        document.querySelectorAll('.sidebar-nav-item').forEach(i => i.style.background = '');
        item.style.background = 'var(--surface-hover)';
        if (window.innerWidth <= 768) toggleSidebar();
      });
    });

// Load sessions into sidebar
async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    currentSessionId = data.currentId;
    renderSessions(data.sessions, data.currentId);
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

function renderSessions(sessions, activeId) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);

  const groups = { today: [], yesterday: [], week: [], older: [] };
  sessions.forEach(s => {
    const d = new Date(s.updatedAt || s.createdAt);
    if (d >= today) groups.today.push(s);
    else if (d >= yesterday) groups.yesterday.push(s);
    else if (d >= weekAgo) groups.week.push(s);
    else groups.older.push(s);
  });

  let html = '';
  function addGroup(label, items) {
    if (items.length === 0) return;
    html += '<div class="sidebar-group-label">' + label + '</div>';
    items.forEach(s => {
      const active = s.id === activeId ? ' active' : '';
      const title = (s.title || 'Untitled').replace(/</g, '&lt;');
      html += '<div class="sidebar-item' + active + '" data-id="' + s.id + '">'
        + '<span class="sidebar-item-title">' + title + '</span>'
        + '<div style="display:flex;gap:2px;align-items:center;">'
        + '<button class="sidebar-item-export" data-id="' + s.id + '" title="Export as Markdown" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:2px 4px;font-size:13px;opacity:0.6;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">⬇</button>'
        + '<button class="sidebar-item-delete" data-id="' + s.id + '" title="Delete">\u00d7</button>'
        + '</div>'
        + '</div>';
    });
  }
  addGroup('Today', groups.today);
  addGroup('Yesterday', groups.yesterday);
  addGroup('Previous 7 Days', groups.week);
  addGroup('Older', groups.older);

  if (!html) html = '<div style="padding:16px;color:var(--text-tertiary);font-size:13px;">No conversations yet</div>';
  sessionList.innerHTML = html;

  // Bind click handlers
  sessionList.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('sidebar-item-delete')) return;
      switchToSession(item.dataset.id);
    });
  });
  sessionList.querySelectorAll('.sidebar-item-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSessionById(btn.dataset.id);
    });
  });
  sessionList.querySelectorAll('.sidebar-item-export').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open('/api/sessions/' + btn.dataset.id + '/export', '_blank');
    });
  });

  // Apply current search filter if any
  const searchInput = document.getElementById('sessionSearch');
  if (searchInput && searchInput.value.trim()) {
    filterSessions(searchInput.value.trim().toLowerCase());
  }
}

function filterSessions(query) {
  const items = sessionList.querySelectorAll('.sidebar-item');
  const labels = sessionList.querySelectorAll('.sidebar-group-label');
  items.forEach(item => {
    const title = item.querySelector('.sidebar-item-title')?.textContent?.toLowerCase() || '';
    item.style.display = title.includes(query) ? '' : 'none';
  });
  // Hide group labels if all items in that group are hidden
  labels.forEach(label => {
    let next = label.nextElementSibling;
    let anyVisible = false;
    while (next && !next.classList.contains('sidebar-group-label')) {
      if (next.style.display !== 'none') anyVisible = true;
      next = next.nextElementSibling;
    }
    label.style.display = anyVisible ? '' : 'none';
  });
}

async function switchToSession(id) {
  showChatView();
  try {
    const res = await fetch('/api/sessions/' + id + '/switch', { method: 'POST' });
    const data = await res.json();
    currentSessionId = data.sessionId;
    messages.innerHTML = '';

    if (data.messages.length === 0) {
      showWelcome();
    } else {
      data.messages.forEach(m => {
        if (m.role === 'canvas') {
          // Re-render canvas bubble from persisted data
          renderCanvasBubble(m.html, m.title);
        } else {
          const type = m.role === 'user' ? 'user' : 'agent';
          addMsg(m.text, type);
        }
      });
    }
    loadSessions();
    // Close sidebar on mobile
    if (window.innerWidth <= 768) toggleSidebar();
  } catch (err) {
    console.error('Switch failed:', err);
  }
}

async function deleteSessionById(id) {
  try {
    await fetch('/api/sessions/' + id, { method: 'DELETE' });
    if (id === currentSessionId) {
      showWelcome();
    }
    loadSessions();
  } catch (err) {
    console.error('Delete failed:', err);
  }
}

// Suggestion chips
function bindSuggestions() {
  document.querySelectorAll('.suggestion').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.msg;
      sendMessage();
      thinkingRow = showThinking();
    });
  });
}
bindSuggestions();

// Load sessions on startup
loadSessions();

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => {
    console.log('Service Worker registered');
  }).catch(err => {
    console.warn('SW registration failed:', err);
  });
}

// ── Voice Mode (Gemini Live API) ──────────────────────────
(function() {
  const voiceModeBtn = document.getElementById('voiceModeBtn');
  const overlay = document.getElementById('voiceOverlay');
  const orb = document.getElementById('voiceOrb');
  const statusEl = document.getElementById('voiceStatus');
  const transcriptEl = document.getElementById('voiceTranscript');
  const endBtn = document.getElementById('voiceEndBtn');

  if (!voiceModeBtn || !overlay) return;

  let voiceActive = false;
  let mediaStream = null;
  let audioCtx = null;
  let scriptNode = null;
  let playbackCtx = null;
  let playbackQueue = [];
  let isPlaying = false;
  let inputTranscript = '';
  let outputTranscript = '';

  var screenSharing = false;
  function setVoiceState(state) {
    orb.className = 'voice-orb ' + state;
    var labels = {
      '': 'Connecting…',
      'listening': 'Listening…',
      'thinking': 'Thinking…',
      'speaking': 'Speaking…',
    };
    var label = labels[state] || state;
    if (screenSharing && state) label += ' · 🖥️ Sharing';
    statusEl.textContent = label;
  }

  // Convert Float32 audio samples to 16-bit PCM
  function float32ToPcm16(float32) {
    var pcm16 = new Int16Array(float32.length);
    for (var i = 0; i < float32.length; i++) {
      var s = Math.max(-1, Math.min(1, float32[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16;
  }

  // Downsample from source rate to 16kHz
  function downsample(buffer, fromRate) {
    if (fromRate === 16000) return buffer;
    var ratio = fromRate / 16000;
    var newLen = Math.round(buffer.length / ratio);
    var result = new Float32Array(newLen);
    for (var i = 0; i < newLen; i++) {
      result[i] = buffer[Math.round(i * ratio)];
    }
    return result;
  }

  // ArrayBuffer to base64
  function bufferToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Play queued PCM audio chunks (24kHz, 16-bit, mono) — gap-free scheduling
  var nextPlayTime = 0;
  var scheduledSources = [];

  function scheduleChunk(base64) {
    if (!playbackCtx) {
      playbackCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      nextPlayTime = playbackCtx.currentTime;
    }

    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Convert 16-bit PCM to Float32
    var int16 = new Int16Array(bytes.buffer);
    var float32 = new Float32Array(int16.length);
    for (var j = 0; j < int16.length; j++) {
      float32[j] = int16[j] / 32768.0;
    }

    var audioBuffer = playbackCtx.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);
    var source = playbackCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playbackCtx.destination);

    // Schedule this chunk right after the previous one
    var startAt = Math.max(nextPlayTime, playbackCtx.currentTime);
    source.start(startAt);
    nextPlayTime = startAt + audioBuffer.duration;

    scheduledSources.push(source);
    source.onended = function() {
      var idx = scheduledSources.indexOf(source);
      if (idx >= 0) scheduledSources.splice(idx, 1);
      // When all chunks are done playing, go back to listening
      if (scheduledSources.length === 0 && playbackQueue.length === 0 && voiceActive) {
        isPlaying = false;
        setVoiceState('listening');
      }
    };
  }

  function playNextChunk() {
    while (playbackQueue.length > 0) {
      scheduleChunk(playbackQueue.shift());
    }
    isPlaying = true;
  }

  function stopPlayback() {
    playbackQueue.length = 0;
    isPlaying = false;
    nextPlayTime = 0;
    for (var i = 0; i < scheduledSources.length; i++) {
      try { scheduledSources[i].stop(); } catch {}
    }
    scheduledSources.length = 0;
    if (playbackCtx) {
      try { playbackCtx.close(); } catch {}
      playbackCtx = null;
    }
  }

  async function startVoiceMode() {
    voiceActive = true;
    overlay.classList.add('active');
    transcriptEl.textContent = '';
    inputTranscript = '';
    outputTranscript = '';
    setVoiceState('');

    // Request microphone access
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      alert('Microphone access denied. Voice mode requires microphone permission.');
      voiceActive = false;
      overlay.classList.remove('active');
      return;
    }

    // Send voice_start to server (triggers Gemini Live session creation)
    if (window._aliceWs && window._aliceWs.readyState === 1) {
      window._aliceWs.send(JSON.stringify({ type: 'voice_start' }));
    }

    // Set up audio capture with ScriptProcessorNode
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var source = audioCtx.createMediaStreamSource(mediaStream);
    // 4096 samples per buffer for ~85ms chunks at 48kHz
    scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);

    scriptNode.onaudioprocess = function(e) {
      if (!voiceActive) return;
      var inputData = e.inputBuffer.getChannelData(0);
      // Downsample to 16kHz
      var downsampled = downsample(inputData, audioCtx.sampleRate);
      var pcm16 = float32ToPcm16(downsampled);
      var base64 = bufferToBase64(pcm16.buffer);

      // Send to server
      if (window._aliceWs && window._aliceWs.readyState === 1) {
        window._aliceWs.send(JSON.stringify({ type: 'voice_audio_in', audio: base64 }));
      }
    };

    source.connect(scriptNode);
    scriptNode.connect(audioCtx.destination);
  }

  function endVoiceMode() {
    voiceActive = false;
    overlay.classList.remove('active');
    stopPlayback();
    stopScreenShare();

    // Stop microphone
    if (scriptNode) {
      scriptNode.disconnect();
      scriptNode = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(function() {});
      audioCtx = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function(t) { t.stop(); });
      mediaStream = null;
    }

    // Tell server to close the Live session
    if (window._aliceWs && window._aliceWs.readyState === 1) {
      window._aliceWs.send(JSON.stringify({ type: 'voice_stop' }));
    }

    setVoiceState('');
  }

  voiceModeBtn.addEventListener('click', function() {
    if (voiceActive) {
      endVoiceMode();
    } else {
      startVoiceMode();
    }
  });

  endBtn.addEventListener('click', endVoiceMode);

  // ── Screen Share ──
  var shareBtn = document.getElementById('voiceShareBtn');
  var sharePreview = document.getElementById('voiceSharePreview');
  var shareVideo = document.getElementById('voiceShareVideo');
  var shareStream = null;
  var shareInterval = null;
  var shareCanvas = document.createElement('canvas');
  var shareCtx2d = shareCanvas.getContext('2d');

  function stopScreenShare() {
    if (shareInterval) { clearInterval(shareInterval); shareInterval = null; }
    if (shareStream) {
      shareStream.getTracks().forEach(function(t) { t.stop(); });
      shareStream = null;
    }
    if (shareVideo) shareVideo.srcObject = null;
    if (sharePreview) sharePreview.style.display = 'none';
    if (shareBtn) shareBtn.classList.remove('active');
  }

  async function toggleScreenShare() {
    if (shareStream) {
      stopScreenShare();
      return;
    }
    try {
      shareStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 1, max: 2 }, width: { ideal: 768 }, height: { ideal: 768 } },
        audio: false,
      });

      // Show preview
      shareVideo.srcObject = shareStream;
      sharePreview.style.display = 'block';
      shareBtn.classList.add('active');

      // Handle user stopping share via browser UI
      shareStream.getVideoTracks()[0].onended = function() {
        stopScreenShare();
      };

      // Capture and send frames at ~1 FPS
      shareInterval = setInterval(function() {
        if (!shareStream || !voiceActive) { stopScreenShare(); return; }
        var track = shareStream.getVideoTracks()[0];
        if (!track || track.readyState !== 'live') { stopScreenShare(); return; }

        var settings = track.getSettings();
        var w = settings.width || 768;
        var h = settings.height || 768;
        // Scale down to max 768px
        var scale = Math.min(768 / w, 768 / h, 1);
        shareCanvas.width = Math.round(w * scale);
        shareCanvas.height = Math.round(h * scale);
        shareCtx2d.drawImage(shareVideo, 0, 0, shareCanvas.width, shareCanvas.height);

        var dataUrl = shareCanvas.toDataURL('image/jpeg', 0.6);
        var base64 = dataUrl.split(',')[1];
        if (window._aliceWs && window._aliceWs.readyState === 1) {
          window._aliceWs.send(JSON.stringify({ type: 'voice_video_frame', frame: base64 }));
        }
      }, 1000);
    } catch (err) {
      console.warn('Screen share failed:', err);
    }
  }

  if (shareBtn) {
    shareBtn.addEventListener('click', toggleScreenShare);
  }

  // Handle Escape key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && voiceActive) {
      endVoiceMode();
    }
  });

  // Handle voice WebSocket messages
  function hookVoiceMessages() {
    var checkWs = setInterval(function() {
      if (window._aliceWs) {
        clearInterval(checkWs);
        window._aliceWs.addEventListener('message', function(event) {
          var data;
          try { data = JSON.parse(event.data); } catch { return; }
          if (!voiceActive) return;

          if (data.type === 'voice_ready') {
            setVoiceState('listening');
          }

          if (data.type === 'voice_status') {
            setVoiceState(data.status);
          }

          if (data.type === 'voice_audio_chunk') {
            // Queue Gemini's audio response for playback
            setVoiceState('speaking');
            playbackQueue.push(data.audio);
            playNextChunk();
          }

          if (data.type === 'voice_interrupted') {
            // Gemini detected user barge-in, stop playback
            stopPlayback();
            setVoiceState('listening');
            outputTranscript = '';
          }

          if (data.type === 'voice_turn_complete') {
            // Model finished speaking
            if (playbackQueue.length === 0 && !isPlaying) {
              setVoiceState('listening');
              outputTranscript = '';
            }
          }

          if (data.type === 'voice_input_transcript') {
            inputTranscript += data.text;
            transcriptEl.textContent = inputTranscript;
          }

          if (data.type === 'voice_output_transcript') {
            outputTranscript += data.text;
            transcriptEl.textContent = outputTranscript;
          }

          if (data.type === 'voice_session_closed') {
            if (voiceActive) endVoiceMode();
          }

          if (data.type === 'voice_error') {
            transcriptEl.textContent = 'Error: ' + (data.error || 'Something went wrong');
            setVoiceState('listening');
            setTimeout(function() {
              if (voiceActive) {
                transcriptEl.textContent = '';
                inputTranscript = '';
              }
            }, 2000);
          }

          // Voice tool call indicator
          if (data.type === 'voice_tool_call') {
            var toolPill = document.getElementById('voiceToolPill');
            var toolName = document.getElementById('voiceToolName');
            if (toolPill && toolName) {
              var friendlyNames = {
                web_search: 'Searching the web…',
                search_memory: 'Searching memory…',
                semantic_search: 'Searching knowledge…',
                browse_page: 'Reading a page…',
                set_reminder: 'Setting reminder…',
                generate_image: 'Creating image…',
                get_location: 'Getting location…',
                deep_research: 'Running deep research…',
                knowledge_graph: 'Querying knowledge graph…',
                add_knowledge: 'Updating knowledge graph…',
              };
              var name = data.tool || data.name || 'tool';
              toolName.textContent = friendlyNames[name] || ('Using ' + name + '…');
              toolPill.classList.add('visible');
              setTimeout(function() { toolPill.classList.remove('visible'); }, 8000);
            }
          }
        });
      }
    }, 200);
  }
  hookVoiceMessages();

  // --- Notification Center ---
  var notifHistory = [];
  var notifBell = document.getElementById('notifBell');
  var notifDropdown = document.getElementById('notifDropdown');
  var notifBadge = document.getElementById('notifBadge');
  var notifList = document.getElementById('notifList');
  var notifClear = document.getElementById('notifClear');

  function addNotification(msg, priority) {
    notifHistory.unshift({ message: msg, priority: priority || 'info', time: new Date() });
    if (notifHistory.length > 50) notifHistory.pop();
    notifBadge.classList.add('visible');
    renderNotifList();
  }

  function renderNotifList() {
    if (!notifList) return;
    if (notifHistory.length === 0) {
      notifList.innerHTML = '<div class="notification-empty">No notifications yet</div>';
      return;
    }
    var icons = { info: 'ℹ️', warning: '⚠️', urgent: '🚨' };
    notifList.innerHTML = notifHistory.map(function(n) {
      var ago = formatTimeAgo(n.time);
      return '<div class="notification-item">' +
        '<span>' + (icons[n.priority] || '🔔') + '</span>' +
        '<span style="flex:1;">' + escapeHtml(n.message) + '</span>' +
        '<span class="notification-time">' + ago + '</span></div>';
    }).join('');
  }

  function formatTimeAgo(date) {
    var s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function escapeHtml(s) {
    var d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }

  if (notifBell) {
    notifBell.addEventListener('click', function(e) {
      e.stopPropagation();
      notifDropdown.classList.toggle('open');
      notifBadge.classList.remove('visible');
      renderNotifList();
    });
  }
  if (notifClear) {
    notifClear.addEventListener('click', function() {
      notifHistory = [];
      renderNotifList();
    });
  }
  document.addEventListener('click', function() {
    if (notifDropdown) notifDropdown.classList.remove('open');
  });
  if (notifDropdown) {
    notifDropdown.addEventListener('click', function(e) { e.stopPropagation(); });
  }

  // --- Knowledge Graph Modal ---
  var kgBtn = document.getElementById('kgBtn');
  var kgModal = document.getElementById('kgModal');
  var kgClose = document.getElementById('kgClose');
  var kgSearch = document.getElementById('kgSearch');
  var kgEntities = document.getElementById('kgEntities');

  function openKgModal() {
    kgModal.classList.add('open');
    fetchKgData();
  }

  function closeKgModal() {
    kgModal.classList.remove('open');
  }

  function fetchKgData(query) {
    var url = '/api/knowledge-graph';
    if (query) url += '?q=' + encodeURIComponent(query);
    fetch(url).then(function(r) { return r.json(); }).then(function(data) {
      renderKgEntities(data.entities || []);
    }).catch(function() {
      kgEntities.innerHTML = '<div class="kg-empty">Failed to load knowledge graph</div>';
    });
  }

  function renderKgEntities(entities) {
    if (entities.length === 0) {
      kgEntities.innerHTML = '<div class="kg-empty">No entities found. Ask Alice to add knowledge!</div>';
      return;
    }
    kgEntities.innerHTML = entities.map(function(e) {
      var rels = (e.relations || []).map(function(r) {
        return '<div class="kg-rel"><span class="kg-rel-arrow">' +
          (r.direction === 'from' ? '→' : '←') + '</span> ' +
          escapeHtml(r.relation) + ' → <strong>' + escapeHtml(r.entity) + '</strong></div>';
      }).join('');
      return '<div class="kg-entity-card">' +
        '<div><span class="kg-entity-name">' + escapeHtml(e.name) + '</span>' +
        '<span class="kg-entity-type">' + escapeHtml(e.type) + '</span></div>' +
        (e.description ? '<div class="kg-entity-desc">' + escapeHtml(e.description) + '</div>' : '') +
        (rels ? '<div class="kg-entity-rels">' + rels + '</div>' : '') +
        '</div>';
    }).join('');
  }

  if (kgBtn) kgBtn.addEventListener('click', openKgModal);
  if (kgClose) kgClose.addEventListener('click', closeKgModal);
  if (kgModal) kgModal.addEventListener('click', function(e) { if (e.target === kgModal) closeKgModal(); });
  if (kgSearch) {
    var kgDebounce;
    kgSearch.addEventListener('input', function() {
      clearTimeout(kgDebounce);
      kgDebounce = setTimeout(function() { fetchKgData(kgSearch.value); }, 300);
    });
  }

  // --- Screen share badge updates ---
  var origToggleShare = window.toggleScreenShare;
  // Track screen sharing state for voice status badge
  var sharePreview = document.getElementById('voiceSharePreview');
  if (sharePreview) {
    var observer = new MutationObserver(function() {
      screenSharing = sharePreview.style.display !== 'none' && sharePreview.style.display !== '';
    });
    observer.observe(sharePreview, { attributes: true, attributeFilter: ['style'] });
  }

  // --- Deep Research + Parallel Tasks Progress ---
  // Hook into main WS to catch tool_output events for progress
  var researchCheckWs = setInterval(function() {
    if (window._aliceWs) {
      clearInterval(researchCheckWs);
      window._aliceWs.addEventListener('message', function(event) {
        var data;
        try { data = JSON.parse(event.data); } catch { return; }

        // Notification handler
        if (data.type === 'notification') {
          addNotification(data.message || 'Notification', data.priority);
        }

        // Deep research progress
        if (data.type === 'tool_output' && data.tool === 'deep_research' && data.status === 'progress') {
          var existing = document.getElementById('deep-research-progress');
          if (!existing) {
            var chatArea = document.getElementById('messages');
            if (chatArea) {
              var bar = document.createElement('div');
              bar.id = 'deep-research-progress';
              bar.className = 'deep-research-bar';
              bar.innerHTML = '🔬 <span>Deep Research in progress… <span id="dr-elapsed">0s</span></span>' +
                '<div class="progress-track"><div class="progress-fill"></div></div>';
              chatArea.appendChild(bar);
              chatArea.scrollTop = chatArea.scrollHeight;
              // Start elapsed timer
              var drStart = Date.now();
              var drTimer = setInterval(function() {
                var el = document.getElementById('dr-elapsed');
                if (el) el.textContent = Math.floor((Date.now() - drStart) / 1000) + 's';
                else clearInterval(drTimer);
              }, 1000);
            }
          }
        }
        if (data.type === 'tool_output' && data.tool === 'deep_research' && data.status === 'complete') {
          var bar = document.getElementById('deep-research-progress');
          if (bar) bar.remove();
        }
      });
    }
  }, 200);

})();

<\/script>
  </body>
  </html>`;


