# postmortem-plugin package

Core implementation package for the OpenCode postmortem plugin.

## Contents

- `src/`: plugin tools, snapshot capture, rule selection, injection, storage
- `test/`: unit and integration tests

## Local development

```bash
bun install
bun test
bunx tsc -p . --noEmit
bun run build
```

## Runtime integration

This package is wired by `.opencode/plugins/postmortem.ts` at repository root.

OpenCode plugin docs: `https://opencode.ai/docs/plugins`
