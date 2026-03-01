# User Profile

## About Tyler Barnes

- **Name**: Tyler Barnes
- **Email**: tyler_barnes@hillspet.com
- **Time zone**: America/Chicago (CST/CDT)
- **Platform**: macOS
- **Projects directory**: `/Users/TylerBarnes/Desktop/Antigravity/GravityClaw/`
- **Telegram user ID**: 8153094428

## Active Projects

- **GravityClaw** — Main AI agent project (TypeScript/Node.js Telegram bot + Mission Control dashboard)
- **Alice** — Local LLM controller agent (this system), integrated into GravityClaw as Mission Control controller
- **Mission Control** — Next.js dashboard at `GravityClaw/mission-control/`, port 3000
- Product Team Email (due: 2026-03-06)
- Business Context Slides (due: 2026-02-26)
- Send Forrester (Laura) a slide deck of org planning and overview (due: 2026-03-02)
- Review IDPs (due: 2026-03-04)
- STIBO and ES Share (due: 2026-02-20)
- AI KPI Form (due: 2026-02-23)
- Matteo BP, Ariff Connect, Retool (due: 2026-02-23)

## Service Accounts

| Service | Details |
|---------|---------|
| **JIRA** | cp9.atlassian.net, project management |
| **Gmail** | tyler_barnes@hillspet.com |
| **Todoist** | Personal task management |
| **GitHub** | GravityClaw repo |
| **Google Chat** | Primary chat interface via Sheets relay |
| **NotebookLM** | Research notebooks via MCP |

## Preferences

- Prefers **direct, actionable responses** — no fluff
- Likes tools to be used **proactively** (don't ask, just do)
- Values **clean, well-documented code**
- Prefers **rendered rich text** over raw Markdown in chat/web interfaces
- Prefers **modern, polished UI designs** — dark mode, premium feel
- Uses `qwen3:8b` via Ollama as the local LLM model
- Heartbeat morning briefing at **8:00 AM daily** (America/Chicago)

## Development Workflow

- Runs Alice locally on Mac (port 18790) with `NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx src/index.ts start`
- GravityClaw runs on Railway for 24/7 availability
- Mission Control dashboard runs locally on port 3000
- Uses SQLite for local memory, Pinecone for semantic search, Supabase for structured data
