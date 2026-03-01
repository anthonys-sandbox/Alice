# Long-Term Memory

Facts, patterns, and knowledge curated by Alice over time.

## Technical Knowledge

- **Google Chat Formatting**: Google Chat has restricted support for standard Markdown. It supports bold (`*`), italics (`_`), strikethrough (`~`), and inline/multiline code blocks, but not standard Markdown headers (`#`) or standard lists. A custom formatter (`formatForGoogleChat` in `src/utils/markdown.ts`) is used to bridge this gap.

## Common Patterns

(Populated by the agent as it learns)

## Important Notes

(Populated by the agent as it learns)

## Learned 2026-03-01
- User is in directory `/Users/username/Projects/Gravity-3D` based on shell prompt
- Error indicates directory `/Users/username/Projects/Gravity-3D` does not exist
- Shell environment uses bash
- Heartbeat scheduler runs every 30 minutes by default
- User may have typo, case sensitivity, or space issues in directory path
- Suggested command: `df -h .` to check disk space for current directory
- Project name mentioned: Gravity-3D
- User needs to verify directory existence before proceeding

## Learned 2026-03-01
- User frequently manages large files in the `Downloads` directory, indicating potential storage management or data organization habits
- Tools used: `bash` for file listing and sorting by size
- File types suggest work with compression (zip, tar.gz), media (mp4), databases (sql), and scripts (sh)
- Filenames include date-based naming (e.g., `_2023`) and project-specific identifiers (e.g., `simulation_data_2023`, `development_env_setup`)
- Recurring patterns: backup-related files (e.g., `backup_db_2023.sql`, `encrypted_documents.enc`), media files (e.g., `big_video_recording.mp4`), and compressed archives (e.g., `.zip`, `.tar.gz`)
- Tech stack includes command-line tools for file management and Unix-based environment (implied by `bash` usage)

## Learned 2026-03-01
- User relies on a specific directory path (`/Users/username/Downloads`) for file operations
- Tool `list_directory` is used to access files in the Downloads folder
- User's environment lacks the `/Users/username/Downloads` directory or has access issues
- Workflow involves checking directory existence and permissions for file operations
- User expects default directories (like Downloads) to be present without manual configuration

## Learned 2026-03-01
- User's home directory is located at `/Users/AnthonyTackett` with ownership `AnthonyTackett:staff`.
- System/service account directory `/Users/cplapsadmin` exists with ownership `cplapsadmin:staff`.
- Shared directory `/Users/Shared` has permissions `rwxrwxrwt` (world-writable with sticky bit).
- Hidden files/entries include `.localized` (a macOS hidden file).
- Tool `list_directory` was used to retrieve the directory listing.

## Learned 2026-03-01
- The project's monitoring system checks for crashed dev servers and disk space usage (>90% threshold) during heartbeats
- `df -h` command is executed in a bash environment for disk space monitoring
- `df -h` failed with exit code 1, indicating potential command/environment issues
