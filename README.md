<p align="center">
  <img src="public/alice-icon-512.png" width="120" height="120" alt="Alice" style="border-radius: 50%">
</p>

<h1 align="center">✨ Alice</h1>

<p align="center">
  <strong>A self-hosted AI agent that runs on your Mac.</strong><br>
  Native macOS app, menubar quick-access, web UI, or Google Chat. Powered by Gemini (primary), Ollama &amp; OpenRouter.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#native-macos-app">Native App</a> •
  <a href="#menubar-app">Menubar</a> •
  <a href="#voice-dictation">Voice</a> •
  <a href="#google-chat-integration">Google Chat</a> •
  <a href="#mission-control-dashboard">Dashboard</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#tools">Tools</a> •
  <a href="#memory-system">Memory</a> •
  <a href="#skills">Skills</a>
</p>

---

## What is Alice?

Alice is a personal AI agent runtime that runs entirely on your Mac. She can:

- 🖥️ **Native macOS app** — a standalone `.app` with its own window, powered by WKWebView
- 📌 **Menubar quick-access** — Electron-based menubar app for instant access without switching windows
- 💬 **Web UI** — slick browser-based chat with streaming responses and syntax highlighting
- 🎤 **Voice dictation** — speak to Alice using on-device speech recognition (no cloud, no API keys)
- 🔧 **Use tools** — read/write files, run shell commands, search the web, generate images, manage git repos
- 🧠 **Remember** things about you across conversations using a markdown-based memory system
- 👁️ **See images** — attach images and Alice automatically switches to a vision model to understand them
- 📱 **Google Chat** — message Alice from your phone and she responds as a proper Chat app
- 📲 **PWA** — install as an app on your phone or desktop for quick access
- ⏰ **Reminders & file watchers** — schedule tasks with cron expressions or relative times
- 📅 **Cron jobs** — persistent scheduled jobs stored in SQLite with a full management API
- ☀️ **Morning briefing** — daily Cards v2 briefing to Google Chat with weather, calendar (AI summary + desk time), and inbox (AI highlights + action items)
- 💓 **Heartbeat** — periodic self-checks with reporting to Google Chat
- 🦀 **Skills** — extend Alice with custom skill files
- 🎨 **Canvas** — Alice pushes interactive HTML/JS inline in chat (charts, games, dashboards); persists across restarts, supports CDN libraries (Chart.js etc.), and has a fullscreen expand mode
- 📋 **Message queue** — send multiple messages while Alice is busy; they queue and process in order
- 🌐 **Persistent browser** — Chromium with saved cookies and login sessions across restarts
- 📍 **Location services** — Alice can request your device location for weather, directions, etc.
- 🖥️ **Activity console** — live backend visibility panel showing LLM calls, tool usage, rate limits, errors, and timing
- 📊 **Mission Control dashboard** — Command Center (system health, quick actions, cron jobs), Tools & Plugins (categorized + searchable), Memory (search + CRUD), Reminders (create/delete), Connections (providers + MCP servers with tool counts), Settings (runtime model switching)

## Architecture

```
┌──────────────┐
│  Alice.app   │──┐
│  (Native)    │  │   ┌──────────────┐     ┌───────────────┐
└──────────────┘  ├──▶│   Gateway    │────▶│    Agent      │
┌──────────────┐  │   │  (Express +  │◀────│  (ReAct Loop) │
│  Menubar App │──┤   │   WebSocket) │     │               │
│  (Electron)  │  │   └──────────────┘     └───────┬───────┘
└──────────────┘  │                                │
┌──────────────┐  │   ┌──────────────┐     ┌───────▼───────┐
│  Web UI      │──┘   │ Google Chat  │────▶│  LLM Provider │
│  (Browser)   │      │  (Mobile)    │◀────│Gemini/Ollama/OR│
└──────────────┘      └──────────────┘     └───────────────┘
```

---

## Quick Start

### Prerequisites

| Requirement | How to Install |
|---|---|
| **Node.js** ≥ 20 | `brew install node` |
| **Ollama** (for local LLM) | `brew install ollama` or `curl -fsSL https://ollama.com/install.sh \| sh` |
| **Git** | `brew install git` (usually pre-installed) |

### 1. Clone & Install

```bash
git clone git@github.com:anthonys-sandbox/Alice.git
cd alice
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings. Alice supports three providers:

#### Option A: Gemini with Google Ultra (Recommended — free with subscription)

```bash
CHAT_PROVIDER=gemini
GEMINI_AUTH=cli
GEMINI_MODEL=gemini-3-flash-preview
```

Requires one-time setup: `npm install -g @google/gemini-cli && gemini` (see [Gemini CLI Auth](#gemini-cli-auth-google-ultra-subscription))

#### Option B: Gemini with API Key

```bash
CHAT_PROVIDER=gemini
GEMINI_API_KEY=your_key_here  # Get from https://aistudio.google.com/apikey
```

#### Option C: Ollama (Local — free, private, offline-capable)

```bash
CHAT_PROVIDER=ollama
OLLAMA_MODEL=llama3.1:8b
OLLAMA_VISION_MODEL=llama3.1:8b
```

Requires Ollama: `brew install ollama && ollama serve && ollama pull llama3.1:8b`

### 3. Start Alice

```bash
npx tsx src/index.ts start
```

Open **http://localhost:18790** in your browser. That's it! 🎉

### 4. (Optional) Interactive Terminal Chat

```bash
npx tsx src/index.ts chat
```

---

## Native macOS App

Alice includes a standalone native macOS app (`Alice.app`) built with Swift and WKWebView. Double-click it to launch — it starts the server automatically and presents the web UI in a native window with:

- **Transparent titlebar** — clean, frameless look
- **Native speech recognition** — uses `SFSpeechRecognizer` for on-device voice dictation
- **Auto-reconnect** — shows a loading screen while Alice boots, connects automatically when ready
- **Health monitoring** — polls the server every 2 seconds and recovers if Alice restarts

### Building the App

The app source is at `Alice.app/Contents/MacOS/AliceLauncher.swift`. To compile:

```bash
swiftc -o Alice.app/Contents/MacOS/alice \
  Alice.app/Contents/MacOS/AliceLauncher.swift \
  -framework Cocoa -framework WebKit -framework Speech -framework AVFoundation -O
```

> The compiled `.app` bundle is in `.gitignore` — the Swift source file is tracked.

---

## Menubar App

Alice also runs as a **menubar app** for quick access without switching windows. Built with Electron, it lives in your macOS menu bar and drops down a chat panel on click.

### Starting the Menubar

The menubar app launches automatically when Alice starts via `npx tsx src/index.ts start`, or you can run it independently:

```bash
cd menubar && npm install && npx electron .
```

The menubar app connects to the same Alice server instance as the web UI and native app.

---

## Voice Dictation

Alice supports **voice dictation** across all interfaces — click the microphone button next to the input field to speak instead of type.

### How It Works

Voice dictation uses a three-tier system that automatically selects the best available method:

| Surface | Technology | Type |
|---|---|---|
| **Alice.app** (native) | `SFSpeechRecognizer` via Swift bridge | Real-time streaming, fully on-device |
| **Chrome / Safari** | Web Speech API | Real-time streaming |
| **Menubar (Electron)** | `getUserMedia` → server-side transcription | Record-then-transcribe |

- **Native app**: Uses Apple's `SFSpeechRecognizer` directly through a WKWebView ↔ Swift bridge. Transcription happens entirely on-device with no cloud dependency.
- **Web browsers**: Uses the standard Web Speech API (`webkitSpeechRecognition`). Works in Chrome and Safari.
- **Menubar**: Electron's Web Speech API is non-functional on macOS, so the menubar records raw PCM audio via the Web Audio API, constructs a WAV file client-side, and sends it to Alice's `/api/transcribe` endpoint. The server launches `Transcribe.app` (a headless macOS helper app) which uses `SFSpeechRecognizer` for on-device transcription.

### First-Time Setup

macOS will prompt for **Microphone** and **Speech Recognition** permissions on first use. You must allow both. The transcription helper app needs to be compiled:

```bash
# Compile the transcription helper
swiftc -o scripts/Transcribe.app/Contents/MacOS/transcribe \
  scripts/transcribe.swift -framework Cocoa -framework Speech -O
```

---

## Gemini CLI Auth (Google Ultra Subscription)

If you have a **Google AI Ultra** or **Google One AI Premium** subscription, you can route Alice's requests through the same Code Assist API used by the [Gemini CLI](https://github.com/google-gemini/gemini-cli) — **no separate API billing needed**.

### Setup

1. **Install the Gemini CLI:**
   ```bash
   npm install -g @google/gemini-cli
   gemini
   ```
2. **Log in** when prompted — this saves OAuth credentials to `~/.gemini/oauth_creds.json`
3. **Set the auth mode** in your `.env`:
   ```bash
   CHAT_PROVIDER=gemini
   GEMINI_AUTH=cli
   GEMINI_MODEL=gemini-3-flash-preview
   ```
4. **Start Alice** — she'll automatically use your Ultra subscription quota

Tokens refresh automatically. If you log out of the CLI, Alice falls back to API key mode.

---

## Google Chat Integration

This lets you message Alice from Google Chat on your phone or desktop. Alice responds as a proper app (not as you). The architecture uses a Google Sheet as a message queue — Apps Script writes incoming messages to the sheet, Alice polls and responds.

### Prerequisites

- A [Google Cloud Project](https://console.cloud.google.com/) with billing enabled
- The **Google Sheets API** and **Google Chat API** enabled
- An OAuth 2.0 Client ID (for reading the Sheet)
- A Service Account (for sending responses as the app)

### Step 1: Create the Google Sheet

1. Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet
2. Name it **"GravityClaw Relay"** (or whatever you like)
3. Rename the first tab to **`messages`**
4. Add these headers in row 1:

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| id | timestamp | sender | text | status | response | spaceName |

5. Copy the **Sheet ID** from the URL:
   ```
   https://docs.google.com/spreadsheets/d/THIS_IS_YOUR_SHEET_ID/edit
   ```

### Step 2: Create OAuth 2.0 Credentials (For Sheet Access)

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **Create Credentials → OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Name: `Alice`
5. Add **Authorized redirect URI**: `http://localhost:18791/oauth2callback`
6. Click **Create** and copy the **Client ID** and **Client Secret**

### Step 3: Create a Service Account (For Chat API Responses)

This is what lets Alice respond **as the app** instead of as you.

1. Go to [Google Cloud Console → IAM → Service Accounts](https://console.cloud.google.com/iam-admin/service-accounts)
2. Click **Create Service Account**
3. Name: `alice-chat-bot`
4. Click **Create and Continue** → Skip roles → **Done**
5. Click on the new service account → **Keys** tab → **Add Key → JSON**
6. Save the downloaded JSON file to your project root as `alice-chat-sa.json`

> ⚠️ **Important:** This file contains secrets. It's already in `.gitignore` — never commit it.

### Step 4: Set Up the Apps Script Relay

1. Go to [Google Apps Script](https://script.google.com) → **New project**
2. Name the project **"Alice Relay"**
3. Replace the contents of `Code.gs` with the contents of [`scripts/apps-script-relay.js`](scripts/apps-script-relay.js)
4. **Replace** `YOUR_SHEET_ID_HERE` on line 33 with your actual Sheet ID
5. Click **Deploy → New deployment**
6. Type: **Add-on** (not Web app)
7. Click **Deploy**

### Step 5: Configure Google Chat API

1. Go to [Google Cloud Console → Google Chat API → Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat)
2. Fill in:
   - **App name:** Alice
   - **Avatar URL:** (upload your icon or leave blank)
   - **Description:** Personal AI agent
   - **Interactive features:** ✅ Enabled
   - **Connection settings:** Apps Script
   - **Apps Script project:** Select your "Alice Relay" project
   - **Deployment:** Select your deployment
   - **Slash commands:** (optional)
   - **Permissions:** Specific people or your entire org
3. Click **Save**

### Step 6: Share the Sheet with the Service Account

1. Open your Google Sheet
2. Click **Share**
3. Paste the service account email (e.g., `alice-chat-bot@your-project.iam.gserviceaccount.com`)
4. Set permission to **Editor**
5. Uncheck "Notify people" → Click **Share**

### Step 7: Update Your `.env`

```bash
RELAY_SHEET_ID=your_sheet_id_here
GOOGLE_CLIENT_ID=your_oauth_client_id
GOOGLE_CLIENT_SECRET=your_oauth_client_secret
GOOGLE_SA_KEY_PATH=./alice-chat-sa.json
```

### Step 8: Start Alice & Authorize

```bash
npx tsx src/index.ts start
```

On first run, a browser window will open for Google OAuth. Sign in and authorize access to Google Sheets. Your tokens are saved locally — you only need to do this once.

### Step 9: Test It!

1. Open Google Chat
2. Search for **Alice** in the app directory
3. Send a message — you should see "✨ Thinking..." immediately
4. Within a few seconds, Alice will respond directly in the chat

---

## Mission Control Dashboard

The web UI includes a full-featured dashboard accessible via the sidebar. All pages are navigable from the left-hand nav.

| Page | Description |
|---|---|
| **Command Center** | 6 stat cards (uptime, messages, tool calls, API calls, sessions, active model), System Health panel (provider/fallback/connection status), Quick Actions (run briefing, trigger heartbeat, git backup, refresh), Scheduled Jobs with run-now buttons, Top Tools bar chart |
| **Tools & Plugins** | Auto-categorized by type (File System, Web, Browser, Memory, Scheduling, Git, etc). MCP tools are auto-grouped by server name. Collapsible sections with tool count badges and a search/filter bar |
| **Memory** | Tabbed view of memory files (USER, MEMORY, SOUL, IDENTITY, HEARTBEAT). DB-backed items have add/delete with section grouping. Search bar filters items in real time |
| **Reminders** | Full CRUD — create reminders with message + schedule (natural language or cron), view with CRON/ONE-SHOT type badges, delete individual reminders |
| **Connections** | Split view: Providers (Gemini, Ollama) and MCP Servers with status dots, tool count badges, and connection details |
| **Settings** | Runtime model switching via dropdown (grouped by provider), config summary grid, SOUL.md and IDENTITY.md editors with save buttons |

---

## Configuration

Alice uses a layered configuration system:

1. **Defaults** (built-in)
2. **`alice.config.json`** (project root — overrides defaults)
3. **`.env`** (environment variables — overrides everything)

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CHAT_PROVIDER` | `gemini` | LLM provider: `gemini`, `ollama`, or `openrouter` |
| `GEMINI_API_KEY` | — | Gemini API key ([get one](https://aistudio.google.com/apikey)) |
| `GEMINI_AUTH` | `apikey` | Gemini auth mode: `apikey` or `cli` (Google Ultra) |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Gemini model name |
| `OLLAMA_MODEL` | `llama3.1:8b` | Ollama text model (reasoning + tool calling) |
| `OLLAMA_VISION_MODEL` | `llama3.1:8b` | Ollama vision model (auto-used when images attached) |
| `OLLAMA_HOST` | `127.0.0.1` | Ollama server host |
| `OLLAMA_PORT` | `11434` | Ollama server port |
| `OPENROUTER_API_KEY` | — | OpenRouter API key ([get one](https://openrouter.ai/settings/keys)) |
| `RELAY_SHEET_ID` | — | Google Sheet ID for Chat relay |
| `GOOGLE_CLIENT_ID` | — | OAuth client ID for Sheet access |
| `GOOGLE_CLIENT_SECRET` | — | OAuth client secret |
| `GOOGLE_SA_KEY_PATH` | — | Path to service account JSON key |
| `GATEWAY_PORT` | `18790` | Web UI server port |
| `HEARTBEAT_INTERVAL` | `30` | Heartbeat interval in minutes |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

### JSON Config (`alice.config.json`)

```json
{
    "chatProvider": "gemini",
    "gemini": { "model": "gemini-3-flash-preview" },
    "ollama": {},
    "gateway": { "host": "0.0.0.0", "port": 18790 },
    "heartbeat": { "enabled": true, "intervalMinutes": 30 },
    "agent": { "maxIterations": 25, "timeoutMs": 300000 },
    "logging": { "level": "info" },
    "mcp": {
        "servers": [
            {
                "name": "weather",
                "command": "npx",
                "args": ["-y", "open-meteo-mcp-server"]
            }
        ]
    }
}
```

---

## Tools

Alice has built-in tools plus any MCP-provided tools she can use during conversations:

| Tool | Description |
|---|---|
| `read_file` | Read file contents (with optional line range) |
| `write_file` | Create or overwrite a file |
| `edit_file` | Find-and-replace text in a file |
| `list_directory` | List files in a directory |
| `bash` | Execute shell commands |
| `web_search` | Search the web via Brave Search |
| `web_fetch` | Fetch and extract text from a URL |
| `read_pdf` | Extract text from PDF files |
| `generate_image` | Generate images with Gemini |
| `gemini_code` | Generate, modify, or explain code using Gemini |
| `git_status` | Show git repository status |
| `git_diff` | Show file diffs (staged or unstaged) |
| `git_commit` | Stage and commit changes |
| `git_log` | Show recent commit history |
| `git_backup` | Commit all changes and push |
| `clipboard_read` | Read system clipboard |
| `clipboard_write` | Write to system clipboard |

### Browser Tools (Persistent Chromium)

These tools enable full browser automation with a **persistent browser profile** at `~/.alice/browser-profile/`. Cookies, login sessions, and browsing history survive across Alice restarts.

| Tool | Description |
|---|---|
| `browse_page` | Navigate to a URL and extract page content (cookies persist) |
| `screenshot` | Take a screenshot of the current browser page |
| `click_element` | Click an element by CSS selector |
| `type_text` | Type text into an input field |
| `browser_clear_data` | Wipe the persistent browser profile (cookies, cache, sessions) |

### Dynamic Tools (registered at startup)

| Tool | Description |
|---|---|
| `search_memory` | Search Alice's memory files |
| `set_reminder` | Schedule a reminder (`in 5m`, cron expressions) |
| `cancel_reminder` | Cancel a scheduled reminder |
| `list_reminders` | List all active reminders |
| `watch_file` | Watch a file/directory for changes |
| `install_skill` | Install a new skill from a directory |
| `switch_persona` | Switch Alice's personality |
| `canvas` | Push interactive HTML/JS content inline in chat; persists in SQLite, supports fullscreen expand |
| `get_location` | Get the user's device location (lat/lng via browser Geolocation API) |

### Cron Job Tools

| Tool | Description |
|---|---|
| `create_cron_job` | Create a persistent scheduled job (name, cron expression, prompt) |
| `list_cron_jobs` | List all active cron jobs |
| `delete_cron_job` | Remove a cron job by ID |

---

## Memory System

Alice's personality and knowledge are defined by markdown files in the `memory/` directory:

| File | Purpose |
|---|---|
| `IDENTITY.md` | Alice's name, role, and capabilities |
| `SOUL.md` | Personality, values, and communication style |
| `USER.md` | Information about you (preferences, context) |
| `MEMORY.md` | Long-term memories and learned facts |
| `HEARTBEAT.md` | Instructions for periodic self-check reports |

Edit these files to customize Alice's behavior. They're loaded into the system prompt on every startup and heartbeat cycle.

---

## Skills

Skills are modular instruction sets that extend Alice's capabilities. They live in:

- `./skills/` (project-level)
- `~/.alice/skills/` (global)

Each skill is a directory with a `SKILL.md` file containing YAML frontmatter and instructions:

```markdown
---
name: my-skill
description: What this skill does
requires: [some-tool]
---

# Instructions for the skill...
```

List loaded skills:

```bash
npx tsx src/index.ts skills list
```

---

## CLI Reference

```bash
# Start the gateway server (web UI + menubar + Google Chat polling)
npx tsx src/index.ts start [--port 18790] [--no-heartbeat]

# Interactive terminal chat
npx tsx src/index.ts chat

# List loaded skills
npx tsx src/index.ts skills list

# Run health diagnostics
npx tsx src/index.ts doctor
```

---

## Run on Startup (macOS)

Alice includes a `launchd` plist to auto-start on login:

```bash
# First, build the project
npm run build

# Copy the plist (edit paths inside if needed)
cp com.gravityclaw.agent.plist ~/Library/LaunchAgents/

# Load it
launchctl load ~/Library/LaunchAgents/com.gravityclaw.agent.plist

# Check status
launchctl list | grep gravityclaw

# View logs
tail -f ~/.gravityclaw/logs/stdout.log
```

To stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.gravityclaw.agent.plist
```

---

## Access From Your Phone

When Alice starts, she prints a local network URL:

```
📱 Phone access: http://YOUR-MAC.local:18790/
```

Open this URL on any device on the same Wi-Fi network to use the web UI from your phone or tablet.

---

## MCP (Model Context Protocol)

Alice supports MCP servers for extended tool integrations. Configure them in `alice.config.json`:

```json
{
    "mcp": {
        "servers": [
            {
                "name": "weather",
                "command": "npx",
                "args": ["-y", "open-meteo-mcp-server"]
            }
        ]
    }
}
```

MCP tools are discovered automatically at startup and registered as callable functions. The agent sees all MCP tools alongside built-in tools.

> **Note:** MCP tool schemas are automatically sanitized for Gemini compatibility (e.g., numeric enum values are converted to strings).

### Included MCP Servers

| Server | Package | Tools | Description |
|---|---|---|---|
| `weather` | `open-meteo-mcp-server` | 17 | Weather forecasts, air quality, marine, flood, geocoding (free, no API key) |
| `gmail` | `@gongrzhe/server-gmail-autoauth-mcp` | 19 | Gmail read/send/search/filter (requires OAuth — see setup) |
| `google-calendar` | `@cocal/google-calendar-mcp` | 12 | Google Calendar events CRUD, free/busy queries, event responses, multi-account (requires OAuth) |
| `filesystem` | `@anthropic/mcp-filesystem` | 14 | Read/write/search files in allowed directories |
| `github` | `@anthropic/mcp-github` | 26 | GitHub repos, issues, PRs, code search |
| `notebooklm` | `notebooklm-mcp` | 16 | Chat with Gemini through NotebookLM notebooks |

---

## Project Structure

```
alice/
├── Alice.app/                 # Native macOS app (compiled, in .gitignore)
│   └── Contents/MacOS/
│       ├── AliceLauncher.swift # Swift source — WKWebView + SFSpeechRecognizer bridge
│       └── Info.plist         # App bundle metadata + permissions
├── menubar/                   # Electron menubar app
│   ├── main.js               # Electron main process
│   └── package.json          # Menubar dependencies
├── src/
│   ├── index.ts              # Entry point
│   ├── cli/index.ts           # CLI commands (start, chat, skills, doctor)
│   ├── gateway/server.ts      # Express server, WebSocket, web UI, /api/transcribe
│   ├── runtime/
│   │   ├── agent.ts           # Core ReAct agentic loop + model switcher
│   │   ├── providers/
│   │   │   ├── gemini.ts      # Gemini API provider (API key + CLI auth)
│   │   │   ├── gemini-cli-auth.ts # Gemini CLI OAuth token manager
│   │   │   ├── code-assist-client.ts # Code Assist API client (Ultra subscription)
│   │   │   └── oai-provider.ts # OpenAI-compatible provider (Ollama/OpenRouter)
│   │   └── tools/
│   │       ├── registry.ts    # Built-in tool definitions + cron job tools
│   │       └── browser.ts     # Puppeteer browser automation tools
│   ├── channels/
│   │   └── google-chat.ts     # Google Chat adapter (Sheet polling + Cards v2)
│   ├── mcp/
│   │   └── client.ts          # MCP server manager (schema sanitization)
│   ├── memory/
│   │   ├── index.ts           # Memory file loader
│   │   ├── sessions.ts        # SQLite session store
│   │   ├── embeddings.ts      # Embedding-based semantic memory search
│   │   └── memory-store.ts    # Structured memory storage
│   ├── scheduler/
│   │   ├── heartbeat.ts       # Periodic heartbeat system
│   │   ├── cron-jobs.ts       # Persistent cron job system + morning briefing
│   │   └── task-scheduler.ts  # Reminders & file watchers
│   ├── skills/loader.ts       # Skill file loader
│   └── utils/
│       ├── config.ts          # Configuration system
│       ├── logger.ts          # Structured logger
│       ├── markdown.ts        # Markdown/frontmatter parser
│       └── oauth.ts           # Google OAuth token management
├── scripts/
│   ├── apps-script-relay.js   # Google Chat Apps Script relay
│   ├── transcribe.swift       # Speech-to-text CLI source (SFSpeechRecognizer)
│   └── Transcribe.app/       # Compiled helper app (in .gitignore)
├── memory/                    # Memory files (SOUL.md, USER.md, etc.)
├── skills/                    # Custom skill definitions
├── public/                    # Static assets (icons, PWA manifest, service worker)
├── alice.config.json          # Project configuration
├── .env                       # Environment variables (secrets)
└── com.gravityclaw.agent.plist # macOS launchd auto-start
```

---

## License

[MIT](LICENSE)

---

<p align="center">
  <sub>Built with ❤️ by <a href="https://github.com/anthonytackett">Anthony Tackett</a></sub>
</p>