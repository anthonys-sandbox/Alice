# Long-Term Memory

Facts, patterns, and knowledge curated by Alice over time.

## Technical Knowledge

- **Google Chat Formatting**: Google Chat has restricted support for standard Markdown. It supports bold (`*`), italics (`_`), strikethrough (`~`), and inline/multiline code blocks, but not standard Markdown headers (`#`) or standard lists. A custom formatter (`formatForGoogleChat` in `src/utils/markdown.ts`) is used to bridge this gap.

## Common Patterns

(Populated by the agent as it learns)

## Important Notes

(Populated by the agent as it learns)

## Learned 2026-03-01
- Heartbeat scheduler runs every 30 minutes by default
- Disk space check for root partition (`/`) is at 7% usage
- `/System/Volumes/Data` partition is at 51% usage
- No critical disk space thresholds exceeded
- Bash was used as the tool for the check
- System has ample storage available according to the check

## Learned 2026-03-01
- Heartbeat scheduler triggers automated checks every 30 minutes
- Monitoring tasks include checking for crashed dev servers and disk space (warn if >90%)
- Disk usage check focuses on root (`/`) and home (`/home`) partitions
- `df -h` command outputs disk usage in human-readable format (e.g., GB/MB)
- `grep -E '/$|/home$'` filters output to root and home partitions
- `awk '{print $5}'` extracts "used%" column from `df` output
- Disk usage reported as 7% for root partition (normal, sufficient remaining space)
- Tool used: bash commands for disk monitoring and filtering
- Recurring workflow: automated heartbeat cycle with predefined monitoring checks

## Learned 2026-03-01
- User expressed a preference for pizza
- Action taken: Updated likes list via a memory system
- Tool used: write_file
- Assistant's workflow includes confirmation and offer for further adjustments

## Learned 2026-03-01
- "auto-backup" reminder (ID: rem_mm79tq3w) triggers GitHub backup workflow via `git_backup` function
- Backup schedule: every 6 hours at :00 minutes
- Tools used: bash, list_reminders
- Recurring workflows: heartbeat check, GitHub auto-backup
- Environment includes running dev servers and disk space monitoring

## Learned 2026-03-01
- User has a section for adding custom reminders (not yet utilized)
- Assistant reported no critical issues or required actions
- No tools were used for the heartbeat check
- Environment includes dev servers and disk space monitoring
- Recurring workflow involves automated heartbeat checks and potential custom reminders
- Current toolset lacks functions to execute the listed monitoring tasks
