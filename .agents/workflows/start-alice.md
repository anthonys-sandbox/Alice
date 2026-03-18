---
description: How to start, stop, and restart Alice (the AI assistant runtime)
---

# Starting Alice

// turbo-all

1. Kill any existing Alice processes:
```bash
pkill -f "tsx.*index.ts" 2>/dev/null; sleep 1
```

2. Start Alice using the npm script:
```bash
cd /Users/AnthonyTackett/Documents/GitHub/GravityClaw && npm run alice
```

**IMPORTANT:** The correct entry point is `src/index.ts start` (NOT `src/gateway/server.ts`).
The `npm run alice` script handles the correct ignore patterns and entry point.

3. Verify Alice is running by checking for log output like:
```
[Gateway] 📧 Email watcher started
[Gateway] 📊 Report scheduler started
```

# Stopping Alice

1. Kill the process:
```bash
pkill -f "tsx.*index.ts"
```

# Restarting Alice

1. Kill existing processes then start fresh:
```bash
pkill -f "tsx.*index.ts" 2>/dev/null; sleep 1; cd /Users/AnthonyTackett/Documents/GitHub/GravityClaw && npm run alice
```

# Troubleshooting

- If Alice doesn't start, check for port conflicts: `lsof -ti :18790`
- If you see a 400 error about "function response turn", the conversation history is corrupted. Alice auto-recovers by clearing history and retrying.
- Alice uses `tsx watch` so file changes auto-restart the server (except files in `./memory/**`, `./logs/**`, etc.)
