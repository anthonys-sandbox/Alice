<p align="center">
  <img src="public/alice-icon-512.png" width="120" height="120" alt="Alice" style="border-radius: 50%">
</p>

<h1 align="center">✨ Alice</h1>

<p align="center">
  <strong>A self-hosted AI agent that runs locally on your Mac.</strong><br>
  Chat via a beautiful web UI or Google Chat. Powered by Gemini &amp; Ollama.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#google-chat-integration">Google Chat Setup</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#tools">Tools</a> •
  <a href="#memory-system">Memory</a> •
  <a href="#skills">Skills</a>
</p>

---

## What is Alice?

Alice is a personal AI agent runtime that runs entirely on your Mac. She can:

- 💬 **Chat** via a slick web UI with streaming responses and syntax highlighting
- 🔧 **Use tools** — read/write files, run shell commands, search the web, generate images, manage git repos
- 🧠 **Remember** things about you across conversations using a markdown-based memory system
- 📱 **Google Chat** — message Alice from your phone and she responds as a proper Chat app
- ⏰ **Reminders & file watchers** — schedule tasks with cron expressions or relative times
- 💓 **Heartbeat** — periodic self-checks with reporting to Google Chat
- 🦀 **Skills** — extend Alice with custom skill files

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌───────────────┐
│  Web UI      │────▶│   Gateway    │────▶│    Agent      │
│  (Browser)   │◀────│  (Express +  │◀────│  (ReAct Loop) │
│              │ WS  │   WebSocket) │     │               │
└──────────────┘     └──────────────┘     └───────┬───────┘
                                                  │
┌──────────────┐     ┌──────────────┐     ┌───────▼───────┐
│ Google Chat  │────▶│ Apps Script  │────▶│  LLM Provider │
│  (Mobile)    │◀────│ (Sheet Queue)│     │ Ollama/Gemini │
└──────────────┘     └──────────────┘     └───────────────┘
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
git clone https://github.com/anthonytackett/alice.git
cd alice
npm install
```

### 2. Set Up Ollama (Local LLM — Free)

```bash
# Start the Ollama service
ollama serve

# Pull a model (qwen3:8b is the default — great balance of speed & quality)
ollama pull qwen3:8b
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```bash
# Minimum viable config (Ollama only — no API keys needed!)
CHAT_PROVIDER=ollama
OLLAMA_MODEL=qwen3:8b

# For image generation, add a Gemini API key (free tier available)
GEMINI_API_KEY=your_key_here  # Get from https://aistudio.google.com/apikey
```

### 4. Start Alice

```bash
npx tsx src/index.ts start
```

Open **http://localhost:18790** in your browser. That's it! 🎉

### 5. (Optional) Interactive Terminal Chat

```bash
npx tsx src/index.ts chat
```

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

## Configuration

Alice uses a layered configuration system:

1. **Defaults** (built-in)
2. **`alice.config.json`** (project root — overrides defaults)
3. **`.env`** (environment variables — overrides everything)

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CHAT_PROVIDER` | `ollama` | LLM provider: `ollama` (local) or `gemini` (cloud) |
| `GEMINI_API_KEY` | — | Gemini API key ([get one](https://aistudio.google.com/apikey)) |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Gemini model name |
| `OLLAMA_MODEL` | `qwen3:8b` | Ollama model name |
| `OLLAMA_HOST` | `127.0.0.1` | Ollama server host |
| `OLLAMA_PORT` | `11434` | Ollama server port |
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
    "chatProvider": "ollama",
    "ollama": { "model": "qwen3:8b" },
    "gemini": { "model": "gemini-3-flash-preview" },
    "gateway": { "host": "0.0.0.0", "port": 18790 },
    "heartbeat": { "enabled": true, "intervalMinutes": 30 },
    "agent": { "maxIterations": 25, "timeoutMs": 300000 },
    "logging": { "level": "info" }
}
```

---

## Tools

Alice has 16 built-in tools she can use during conversations:

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
| `git_status` | Show git repository status |
| `git_diff` | Show file diffs (staged or unstaged) |
| `git_commit` | Stage and commit changes |
| `git_log` | Show recent commit history |
| `git_backup` | Commit all changes and push |
| `clipboard_read` | Read system clipboard |
| `clipboard_write` | Write to system clipboard |

Additionally, these are registered dynamically at startup:

| Tool | Description |
|---|---|
| `search_memory` | Search Alice's memory files |
| `set_reminder` | Schedule a reminder (`in 5m`, cron expressions) |
| `cancel_reminder` | Cancel a scheduled reminder |
| `list_reminders` | List all active reminders |
| `watch_file` | Watch a file/directory for changes |
| `switch_persona` | Switch Alice's personality |

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
# Start the gateway server (web UI + Google Chat polling)
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

## Project Structure

```
alice/
├── src/
│   ├── index.ts              # Entry point
│   ├── cli/index.ts           # CLI commands (start, chat, skills, doctor)
│   ├── gateway/server.ts      # Express server, WebSocket, web UI
│   ├── runtime/
│   │   ├── agent.ts           # Core ReAct agentic loop
│   │   ├── providers/
│   │   │   ├── gemini.ts      # Gemini API provider
│   │   │   └── oai-provider.ts # OpenAI-compatible provider (Ollama)
│   │   └── tools/registry.ts  # Built-in tool definitions
│   ├── channels/
│   │   └── google-chat.ts     # Google Chat adapter (Sheet polling)
│   ├── memory/
│   │   ├── index.ts           # Memory file loader
│   │   └── sessions.ts        # SQLite session store
│   ├── scheduler/
│   │   ├── heartbeat.ts       # Periodic heartbeat system
│   │   └── task-scheduler.ts  # Reminders & file watchers
│   ├── skills/loader.ts       # Skill file loader
│   └── utils/
│       ├── config.ts          # Configuration system
│       ├── logger.ts          # Structured logger
│       ├── markdown.ts        # Markdown/frontmatter parser
│       └── oauth.ts           # Google OAuth token management
├── memory/                    # Memory files (SOUL.md, USER.md, etc.)
├── skills/                    # Custom skill definitions
├── scripts/
│   └── apps-script-relay.js   # Google Chat Apps Script relay
├── public/                    # Static assets (icons)
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