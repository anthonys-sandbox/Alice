import express from 'express';
import { hostname } from 'os';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { Agent } from '../runtime/agent.js';
import { GoogleChatAdapter } from '../channels/google-chat.js';
import { startHeartbeat, stopHeartbeat } from '../scheduler/heartbeat.js';
import { scheduler } from '../scheduler/task-scheduler.js';
import { createLogger } from '../utils/logger.js';
import type { AliceConfig } from '../utils/config.js';
import { formatForGoogleChat } from '../utils/markdown.js';
import { MCPManager } from '../mcp/client.js';

const log = createLogger('Gateway');

export class Gateway {
  private app: express.Application;
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private agent: Agent;
  private chat: GoogleChatAdapter;
  private config: AliceConfig;
  private mcp: MCPManager;

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

    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', uptime: process.uptime() });
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
        messages: messages.map(m => ({
          role: m.role,
          text: m.parts.filter((p: any) => p.text).map((p: any) => p.text).join(''),
        }))
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
        messages: messages.map(m => ({
          role: m.role,
          text: m.parts.filter((p: any) => p.text).map((p: any) => p.text).join(''),
        })),
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
        const dir = resolve(this.config.memory.dir);
        if (!existsSync(dir)) {
          log.warn('Memory directory not found', { dir });
          res.json({ files: [] });
          return;
        }
        const files = readdirSync(dir)
          .filter((f: string) => f.endsWith('.md'))
          .map((f: string) => ({
            name: f.replace('.md', ''),
            content: readFileSync(join(dir, f), 'utf-8'),
          }));
        res.json({ files });
      } catch (err: any) {
        log.error('Failed to load memory files', { error: err.message });
        res.json({ files: [] });
      }
    });

    // Update a memory file
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
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      log.info('WebSocket client connected');

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
        } catch {
          // Plain text message — no attachments
        }

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
          const response = await this.agent.processMessageStream(
            text,
            (token: string) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'token', text: token }));
              }
            },
            attachments
          );
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
          ws.send(JSON.stringify({ type: 'done', error: err.message }));
        }
      });

      ws.on('close', () => {
        log.info('WebSocket client disconnected');
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

      case '/help': {
        return [
          '**Available Commands:**',
          '• `/status` — Session info (model, tokens, messages)',
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

        resolve();
      });
    });
  }

  /**
   * Stop the gateway server.
   */
  async stop(): Promise<void> {
    stopHeartbeat();
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
  <meta name="apple-mobile-web-app-capable" content="yes">
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
      .header-btn { padding: 0; overflow: hidden; width: 40px; height: 40px; border-radius: 50%; font-size: 0; display: flex; align-items: center; justify-content: center; }
      .header-btn::before { content: '＋'; font-size: 20px; }
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
    /* ── Mic recording state ── */
    .mic-recording {
      color: var(--error) !important;
      animation: micPulse 1.5s ease-in-out infinite;
    }
    @keyframes micPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
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
        <button class="header-btn" id="newChatBtn">＋ New Chat</button>
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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
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
      content.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
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

    // ── Voice Dictation (Web Speech API) ──
    const micBtn = document.getElementById('micBtn');
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition && micBtn) {
      micBtn.style.display = '';
      let recognition = null;
      let isListening = false;

      micBtn.addEventListener('click', () => {
        if (isListening) {
          recognition.stop();
          return;
        }

        recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        // Snapshot what's already in the input BEFORE dictation starts
        const preExisting = input.value;
        let finalTranscript = '';

        recognition.onstart = () => {
          isListening = true;
          micBtn.classList.add('mic-recording');
          micBtn.title = 'Stop dictation';
        };

        recognition.onresult = (event) => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript + ' ';
            } else {
              interim += event.results[i][0].transcript;
            }
          }
          // Always rebuild from snapshot + accumulated transcript
          const base = preExisting ? preExisting + ' ' : '';
          input.value = base + finalTranscript + (interim ? interim + ' …' : '');
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 160) + 'px';
        };

        recognition.onend = () => {
          isListening = false;
          micBtn.classList.remove('mic-recording');
          micBtn.title = 'Voice dictation';
          // Clean up trailing ellipsis
          input.value = input.value.replace(/\\s*…$/, '').trim();
          input.focus();
        };

        recognition.onerror = (event) => {
          console.warn('Speech recognition error:', event.error);
          isListening = false;
          micBtn.classList.remove('mic-recording');
        };

        recognition.start();
      });
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
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">';
        res.tools.forEach(t => {
          html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;border-left:3px solid var(--accent)">';
          html += '<div style="font-weight:500;color:var(--text-primary);margin-bottom:6px">' + t.name + '</div>';
          html += '<div style="font-size:13px;color:var(--text-secondary);line-height:1.5">' + t.description + '</div></div>';
        });
        html += '</div>';
        showDashboardView(html);
      } else if (page === 'memory') {
        const res = await fetch('/api/memory').then(r => r.json());
        let html = '<h2 style="color:var(--accent);margin-bottom:16px">Memory</h2>';
        res.files.forEach(f => {
          html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px">';
          html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
          html += '<span style="font-weight:500;color:var(--text-primary);text-transform:uppercase;font-size:12px;letter-spacing:0.5px">' + f.name + '</span>';
          html += '<button class="save-mem-btn" data-name="' + f.name + '" style="background:var(--accent);color:#131314;border:none;padding:4px 14px;border-radius:8px;cursor:pointer;font-size:12px">Save</button></div>';
          html += '<textarea class="mem-editor" data-name="' + f.name + '" style="width:100%;min-height:120px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:var(--font);font-size:13px;resize:vertical;line-height:1.5">' + f.content + '</textarea></div>';
        });
        showDashboardView(html);
        dashboardView.querySelectorAll('.save-mem-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const ta = dashboardView.querySelector('.mem-editor[data-name="' + name + '"]');
            await fetch('/api/memory/' + name, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({content: ta.value}) });
            btn.textContent = 'Saved!';
            setTimeout(() => { btn.textContent = 'Save'; }, 2000);
          });
        });
      } else if (page === 'reminders') {
        const res = await fetch('/api/reminders').then(r => r.json());
        let html = '<h2 style="color:var(--accent);margin-bottom:16px">Reminders</h2>';
        if (res.reminders.length === 0) {
          html += '<p style="color:var(--text-secondary)">No active reminders. Ask Alice to set one!</p>';
        } else {
          res.reminders.forEach(r => {
            html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">';
            html += '<div><span style="color:var(--text-primary);font-weight:500">' + (r.message || r.id) + '</span>';
            if (r.cron) html += '<span style="color:var(--text-tertiary);font-size:12px;margin-left:8px">' + r.cron + '</span>';
            html += '</div>';
            html += '<button class="cancel-rem-btn" data-id="' + r.id + '" style="background:#e53935;color:white;border:none;padding:4px 12px;border-radius:8px;cursor:pointer;font-size:12px">Cancel</button></div>';
          });
        }
        showDashboardView(html);
        dashboardView.querySelectorAll('.cancel-rem-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            await fetch('/api/reminders/' + btn.dataset.id, { method: 'DELETE' });
            loadDashboard('reminders');
          });
        });
      } else if (page === 'personas') {
        var html = '<h2 style="color:var(--accent);margin-bottom:16px">Personas</h2>';
        html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;border-left:3px solid var(--accent)">';
        html += '<div style="font-weight:500;color:var(--text-primary);margin-bottom:6px">Alice (Default)</div>';
        html += '<div style="font-size:13px;color:var(--text-secondary);line-height:1.5">Your personal AI assistant with a warm, helpful personality. Manages reminders, searches memory, and helps with coding tasks.</div></div>';
        html += '<p style="color:var(--text-tertiary);margin-top:16px;font-size:13px">More personas coming soon.</p>';
        showDashboardView(html);
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
        const type = m.role === 'user' ? 'user' : 'agent';
        addMsg(m.text, type);
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
<\/script>
  </body>
  </html>`;


