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
