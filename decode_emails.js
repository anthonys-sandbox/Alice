const fs = require('fs');
// We don't have the direct email data as files, so let's use googleapis or just read from the previous tool calls if we had them.
// Wait, I can just use gws tool `workspace_pipeline` or I can simply do a gws tool call for `gmail_read` and parse it via bash jq.
