import express from 'express';
import { hostname } from 'os';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Agent } from '../runtime/agent.js';
import { GoogleChatAdapter } from '../channels/google-chat.js';
import { startHeartbeat, stopHeartbeat } from '../scheduler/heartbeat.js';
import { scheduler } from '../scheduler/task-scheduler.js';
import { createLogger } from '../utils/logger.js';
import type { AliceConfig } from '../utils/config.js';
import { formatForGoogleChat } from '../utils/markdown.js';

const log = createLogger('Gateway');

export class Gateway {
  private app: express.Application;
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private agent: Agent;
  private chat: GoogleChatAdapter;
  private config: AliceConfig;

  constructor(config: AliceConfig) {
    this.config = config;
    this.app = express();
    this.app.use(express.json());
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.agent = new Agent(config);
    this.chat = new GoogleChatAdapter(
      config.googleChat.sheetId,
      config.googleChat.oauthClientId,
      config.googleChat.oauthClientSecret
    );
    this.chat.setAgent(this.agent);

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
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      log.info('WebSocket client connected');

      ws.on('message', async (data: Buffer) => {
        const message = data.toString();
        log.debug('WebSocket message received', { length: message.length });

        try {
          const response = await this.agent.processMessageStream(
            message,
            (token: string) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'token', text: token }));
              }
            }
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Alice</title>
  <meta name="description" content="Alice — Personal AI Assistant">
  <link rel="preconnect" href="https://fonts.googleapis.com">
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
      --bg-primary: #131314;
      --bg-secondary: #1e1f20;
      --bg-tertiary: #282a2c;
      --surface: #1e1f20;
      --surface-hover: #282a2c;
      --border: #3c4043;
      --border-subtle: #2d2e30;
      --text-primary: #e3e3e3;
      --text-secondary: #9aa0a6;
      --text-tertiary: #6e7681;
      --accent: #8ab4f8;
      --accent-dim: rgba(138, 180, 248, 0.1);
      --accent-glow: rgba(138, 180, 248, 0.15);
      --user-bg: #004a77;
      --user-text: #c2e7ff;
      --success: #81c995;
      --error: #f28b82;
      --radius: 20px;
      --radius-sm: 12px;
      --max-width: 768px;
      --font: 'Google Sans', 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'Google Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace;
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
      transition: margin-left 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s;
      overflow: hidden;
      z-index: 20;
    }
    .sidebar.collapsed {
      margin-left: -280px;
      opacity: 0;
    }
    .sidebar-header {
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
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
      transition: all 0.2s;
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
      padding: 12px 16px 4px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .sidebar-item {
      display: flex;
      align-items: center;
      padding: 8px 12px 8px 16px;
      cursor: pointer;
      transition: background 0.15s;
      border-radius: 0 20px 20px 0;
      margin-right: 8px;
      position: relative;
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
      padding: 2px 6px;
      border-radius: 4px;
      transition: all 0.15s;
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
      padding: 14px 16px 14px 12px;
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
      width: 36px; height: 36px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s;
      flex-shrink: 0;
    }
    .menu-btn:hover { background: var(--surface-hover); }
    .menu-btn svg { width: 20px; height: 20px; fill: currentColor; }
    .logo {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, #8ab4f8, #c58af9, #f28b82);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
    }
    .logo svg, .avatar.alice svg, .welcome-icon svg {
      width: 18px; height: 18px;
      fill: #fff;
    }
    .welcome-icon svg {
      width: 32px; height: 32px;
    }
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
      padding: 3px 10px;
      border-radius: 12px;
      font-weight: 500;
      display: flex; align-items: center; gap: 5px;
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
      padding: 24px 16px calc(120px + env(safe-area-inset-bottom, 0px));
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
      gap: 12px;
      max-width: var(--max-width);
      width: 100%;
      margin: 0 auto;
      animation: fadeIn 0.3s ease;
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
      margin-top: 4px;
    }
    .avatar.alice {
      background: linear-gradient(135deg, #8ab4f8, #c58af9);
    }
    .avatar.user-av {
      background: var(--user-bg);
      color: var(--user-text);
      font-weight: 500;
      font-size: 13px;
    }

    .msg-content {
      font-size: 15px;
      line-height: 1.7;
      word-wrap: break-word;
      max-width: calc(var(--max-width) - 50px);
    }
    .msg-row.user .msg-content {
      background: var(--user-bg);
      color: var(--user-text);
      padding: 10px 18px;
      border-radius: var(--radius) var(--radius) 4px var(--radius);
    }
    .msg-row.agent .msg-content {
      padding: 4px 0;
    }

    /* ── Thinking Indicator ─────────── */
    .thinking {
      display: flex; gap: 5px;
      padding: 16px 4px;
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
      margin: 20px 0 8px;
      color: var(--accent);
      font-weight: 500;
    }
    .msg-content h1 { font-size: 1.4em; }
    .msg-content h2 { font-size: 1.2em; }
    .msg-content h3 { font-size: 1.05em; }
    .msg-content p { margin-bottom: 10px; }
    .msg-content ul, .msg-content ol { margin: 0 0 12px 20px; }
    .msg-content li { margin-bottom: 4px; }
    .msg-content strong { color: var(--text-primary); }
    .msg-content a { color: var(--accent); text-decoration: none; }
    .msg-content a:hover { text-decoration: underline; }
    .msg-content hr { border: none; border-top: 1px solid var(--border-subtle); margin: 16px 0; }

    /* ── Inline Code ────────────────── */
    .msg-content code {
      font-family: var(--font-mono);
      background: var(--bg-tertiary);
      padding: 2px 6px;
      border-radius: 6px;
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
    }
    .msg-content pre code {
      background: transparent;
      padding: 16px;
      display: block;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-primary);
      overflow-x: auto;
    }
    .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 14px;
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
      padding: 4px 10px;
      border-radius: 6px;
      transition: all 0.15s;
      display: flex; align-items: center; gap: 4px;
    }
    .copy-btn:hover { background: var(--surface-hover); color: var(--text-primary); }
    .copy-btn.copied { color: var(--success); }

    /* ── Tables ──────────────────────── */
    .msg-content table {
      border-collapse: collapse;
      width: 100%;
      margin: 12px 0;
      font-size: 14px;
    }
    .msg-content th, .msg-content td {
      border: 1px solid var(--border-subtle);
      padding: 8px 14px;
      text-align: left;
    }
    .msg-content th { background: var(--bg-tertiary); color: var(--accent); font-weight: 500; }
    .msg-content tr:nth-child(2n) { background: rgba(255,255,255,0.02); }

    .msg-content blockquote {
      border-left: 3px solid var(--accent);
      color: var(--text-secondary);
      padding-left: 16px;
      margin: 12px 0;
      font-style: italic;
    }

    /* ── Meta / tool info ────────────── */
    .meta {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-top: 12px;
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
      padding: 16px 16px calc(24px + env(safe-area-inset-bottom, 0px));
      background: linear-gradient(transparent, var(--bg-primary) 30%);
      z-index: 10;
    }
    .input-container {
      max-width: var(--max-width);
      margin: 0 auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 28px;
      display: flex;
      align-items: center;
      padding: 4px 8px 4px 20px;
      transition: border-color 0.2s, box-shadow 0.2s;
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
      font-size: 15px;
      font-family: var(--font);
      padding: 12px 0;
      outline: none;
      line-height: 1.4;
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
      transition: all 0.2s;
      flex-shrink: 0;
    }
    #send:hover { background: #aecbfa; transform: scale(1.05); }
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
      animation: fadeIn 0.6s ease;
    }
    .welcome-icon {
      width: 64px; height: 64px;
      background: linear-gradient(135deg, #8ab4f8, #c58af9, #f28b82);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 28px;
    }
    .welcome h2 {
      font-size: 28px;
      font-weight: 400;
      background: linear-gradient(135deg, #8ab4f8, #c58af9);
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
    }
    .suggestion:hover {
      background: var(--surface-hover);
      color: var(--text-primary);
      border-color: var(--accent);
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
        <span class="sidebar-item-title">🛠️ Tools & Plugins</span>
      </div>
      <div class="sidebar-item sidebar-nav-item" data-page="memory">
        <span class="sidebar-item-title">🧠 Memory</span>
      </div>
      <div class="sidebar-item sidebar-nav-item" data-page="reminders">
        <span class="sidebar-item-title">⏰ Reminders</span>
      </div>
      <div class="sidebar-item sidebar-nav-item" data-page="personas">
        <span class="sidebar-item-title">🎭 Personas</span>
      </div>
    </div>
    <div class="sidebar-group-label" style="margin-top:4px">Conversations</div>
    <div class="sidebar-list" id="sessionList"></div>
  </aside>
  <div class="sidebar-overlay" id="sidebarOverlay"></div>

  <!-- Main -->
  <div class="main">
    <header>
      <button class="menu-btn" id="menuBtn" title="Toggle sidebar">
        <svg viewBox="0 0 24 24"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
      </button>
      <div class="logo"><svg viewBox="0 0 24 24"><path d="M10 0C10 7.18 4.48 10 0 10c4.48 0 10 2.82 10 10 0-7.18 5.52-10 10-10-5.52 0-10-2.82-10-10z"/><path d="M18.5 12.5c0 3.59-2.76 5-5 5 2.24 0 5 1.41 5 5 0-3.59 2.76-5 5-5-2.76 0-5-1.41-5-5z"/></svg></div>
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
        <div class="welcome-icon"><svg viewBox="0 0 24 24"><path d="M10 0C10 7.18 4.48 10 0 10c4.48 0 10 2.82 10 10 0-7.18 5.52-10 10-10-5.52 0-10-2.82-10-10z"/><path d="M18.5 12.5c0 3.59-2.76 5-5 5 2.24 0 5 1.41 5 5 0-3.59 2.76-5 5-5-2.76 0-5-1.41-5-5z"/></svg></div>
        <h2>Hi, I'm Alice</h2>
        <p>Your personal AI agent. I can write code, search the web, manage files, and much more.</p>
        <div class="suggestions">
          <button class="suggestion" data-msg="What tools do you have?">🛠️ What can you do?</button>
          <button class="suggestion" data-msg="Show me the git status of this project">📊 Git status</button>
          <button class="suggestion" data-msg="Search my memory for recent topics">🧠 Search memory</button>
          <button class="suggestion" data-msg="Set a reminder in 5 minutes to take a break">⏰ Set reminder</button>
        </div>
      </div>
    </div>

    <div class="input-wrapper">
      <div class="input-container">
        <input id="input" placeholder="Message Alice..." autofocus autocomplete="off" />
        <button id="send">➤</button>
      </div>
    </div>
  </div><!-- /main -->

  <script>
    // White SVG sparkle icon for avatars
    const SPARKLE_SVG = '<svg viewBox="0 0 24 24"><path d="M10 0C10 7.18 4.48 10 0 10c4.48 0 10 2.82 10 10 0-7.18 5.52-10 10-10-5.52 0-10-2.82-10-10z"/><path d="M18.5 12.5c0 3.59-2.76 5-5 5 2.24 0 5 1.41 5 5 0-3.59 2.76-5 5-5-2.76 0-5-1.41-5-5z"/></svg>';

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

    const ws = new WebSocket('ws://' + location.host);
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const welcome = document.getElementById('welcome');
    const clearBtn = document.getElementById('clearBtn');

    function hideWelcome() {
      if (welcome) welcome.style.display = 'none';
    }

    function addMsg(text, type, meta) {
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

      if (type === 'agent') {
        try {
          content.innerHTML = marked.parse(text);
          addCopyButtons(content);
        } catch (err) {
          content.textContent = text;
        }
      } else {
        content.textContent = text;
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
        avatar.textContent = 'A';
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
      content.className = 'msg-content';
      content.innerHTML = '<div class="thinking"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
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

    function sendMessage() {
      const text = input.value.trim();
      if (!text || send.disabled) return;

      addMsg(text, 'user');
      ws.send(text);
      input.value = '';
      send.disabled = true;
    }

    let currentStreamRow = null;
    let currentStreamContent = null;
    let currentStreamText = '';
    let thinkingRow = null;

    ws.onmessage = (e) => {
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
    };

    ws.onopen = () => {
      // Show thinking when sending
      const origSend = sendMessage;
    };

    ws.onerror = (err) => console.error('WebSocket error:', err);
    ws.onclose = () => {
      const status = document.getElementById('status');
      status.innerHTML = '<span class="status-dot" style="background:#f28b82;animation:none"></span> Offline';
      status.style.color = '#f28b82';
      status.style.background = 'rgba(242,139,130,0.1)';
      send.disabled = true;
    };

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

    function showWelcome() {
      messages.innerHTML = \`
        <div class="welcome" id="welcome">
          <div class="welcome-icon"><svg viewBox="0 0 24 24"><path d="M10 0C10 7.18 4.48 10 0 10c4.48 0 10 2.82 10 10 0-7.18 5.52-10 10-10-5.52 0-10-2.82-10-10z"/><path d="M18.5 12.5c0 3.59-2.76 5-5 5 2.24 0 5 1.41 5 5 0-3.59 2.76-5 5-5-2.76 0-5-1.41-5-5z"/></svg></div>
          <h2>Hi, I'm Alice</h2>
          <p>Your personal AI agent. I can write code, search the web, manage files, and much more.</p>
          <div class="suggestions">
            <button class="suggestion" data-msg="What tools do you have?">\ud83d\udee0\ufe0f What can you do?</button>
            <button class="suggestion" data-msg="Show me the git status of this project">\ud83d\udcca Git status</button>
            <button class="suggestion" data-msg="Search my memory for recent topics">\ud83e\udde0 Search memory</button>
            <button class="suggestion" data-msg="Set a reminder in 5 minutes to take a break">\u23f0 Set reminder</button>
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
        showWelcome();
        loadSessions();
      } catch (err) {
        console.error('New chat failed:', err);
      }
    }
    sidebarNewChat.addEventListener('click', startNewChat);
    document.getElementById('newChatBtn').addEventListener('click', startNewChat);

    // Dashboard nav items
    const dashboardActions = {
      tools: 'List all your available tools and what they do',
      memory: 'Search my memory for recent topics',
      reminders: 'List all active reminders',
      personas: 'What persona are you currently using? What personas are available?',
    };
    document.querySelectorAll('.sidebar-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const page = item.dataset.page;
        if (dashboardActions[page]) {
          input.value = dashboardActions[page];
          sendMessage();
          thinkingRow = showThinking();
          if (window.innerWidth <= 768) toggleSidebar();
        }
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
            + '<button class="sidebar-item-delete" data-id="' + s.id + '" title="Delete">\u00d7</button>'
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
    }

    async function switchToSession(id) {
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
  <\/script>
</body>
</html>`;


