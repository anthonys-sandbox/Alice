---
name: example-skill
description: An example skill showing the SKILL.md format
tools: [bash, read_file]
---

# Example Skill

This is a template showing how to create a Alice skill.

## Usage

Place this directory inside `./skills/` or `~/.alice/skills/`.

The agent will automatically discover and load it on startup.

## Instructions for the Agent

When the user asks about example skills or how to create skills, explain:

1. Create a new directory under `skills/` with a descriptive name
2. Add a `SKILL.md` file with YAML frontmatter (name, description, tools, requires)
3. The Markdown body contains instructions the agent should follow when this skill is relevant
4. Skills can optionally include scripts or other files in their directory
