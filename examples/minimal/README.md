# Minimal Example

This folder contains a minimal, practical setup for using `agentpostmortem`.

Files:

- `opencode.json` - minimal plugin configuration for a project
- `commands.md` - full flag-by-flag reference for every command
- `playbooks.md` - end-to-end workflows for real incidents
- `commands/` - one markdown file per command with practical scenarios

How to use this example:

1. Copy `opencode.json` to your project root (or merge the plugin entry into your existing config).
2. Run `npx --package agentpostmortem postmortem-init` to install command and skill templates.
3. Restart OpenCode.
4. Use `commands.md` for exact flags and `playbooks.md` for workflow patterns.
5. Use `commands/` when you want deeper examples for a specific command.

For full installation details, see [INSTALL.md](../../INSTALL.md).
