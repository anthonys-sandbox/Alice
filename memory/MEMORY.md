# Long-Term Memory  
- Assistant cannot send direct messages to external users  
- This is a test from Alice  

# Projects  
- Use the canvas tool for interactive content to ensure HTML renders inline for UI components  
- Mission Control Dashboard uses port 3000  
- Gateway service runs on port 18790  
- System uses a heartbeat scheduler every 30 minutes to check dev servers  

# Technical Knowledge  
- Google Chat supports bold (*), italics (_), strikethrough (~), and code blocks, but not standard Markdown headers or lists. A custom formatter (formatForGoogleChat) bridges this gap  
- Code Assist API (cloudcode-pa.googleapis.com) has strict per-minute rate limits. Request throttling (2s minimum between requests) and smart 429 retry logic are implemented  
- CLI OAuth tokens are scoped only for the Code Assist API — they cannot be used with the standard Gemini API (generativelanguage.googleapis.com.com)  

# Workflows  
- Gateway server runs on port 18790  
- Mission Control dashboard is configured for port 3000
