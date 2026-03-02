# Long-Term Memory

## Technical Knowledge
- Google Chat supports bold (*), italics (_), strikethrough (~), and code blocks, but not standard Markdown headers or lists. A custom formatter (formatForGoogleChat) bridges this gap.
- Code Assist API (cloudcode-pa.googleapis.com) has strict per-minute rate limits. Request throttling (2s minimum between requests) and smart 429 retry logic are implemented.
- CLI OAuth tokens are scoped only for the Code Assist API — they cannot be used with the standard Gemini API (generativelanguage.googleapis.com).

## Projects

## Workflows
- Gateway server runs on port 18790
- Mission Control dashboard is configured for port 3000

## MCP Integrations
- Weather MCP server (open-meteo-mcp-server) installed via npx. Provides 17 tools: weather_forecast, air_quality, marine_weather, geocoding, and regional forecast models. Free, no API key required.
- Mission Control Dashboard runs on Port 3000
- Mission Control Dashboard was found down during heartbeat check on port 3000
- The Mission Control Dashboard runs on port 3000.
- Current disk usage is at 23% (10GiB of 926GiB).
- Used Chart.js for a simple bar chart project with monthly sales dummy data
- Use the canvas tool for interactive content to ensure HTML renders inline for UI components.
- Project: Flappy Bird game using HTML5 Canvas with spacebar/click controls and progressive difficulty
- Project: Flappy Bird game titled 'Flappy Alice'
- System Monitoring: Disk usage at 23% (10GiB of 926GiB) as of last heartbeat
- Project: Flappy Alice game created using canvas tool with physics and score counter
- Tech stack: HTML5 Canvas, Spacebar/Click controls
- Systems: Gateway and Mission Control local development services are operational
