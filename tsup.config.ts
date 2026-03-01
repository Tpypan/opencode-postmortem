import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: { index: "src/index.ts" },
		outDir: "dist",
		format: ["esm"],
		dts: true,
		external: ["@opencode-ai/plugin", "zod"],
		clean: true,
		outExtension: () => ({ js: ".js" }),
	},
	{
		entry: { "postmortem.plugin": "src/postmortem.plugin.ts" },
		outDir: "dist",
		format: ["esm"],
		noExternal: [/.*/],
		splitting: false,
		dts: false,
		banner: {
			js: "/* Bundled fallback build for plugin loading. */",
		},
		outExtension: () => ({ js: ".js" }),
	},
	{
		entry: { "scripts/init": "scripts/init.ts" },
		outDir: "dist",
		format: ["esm"],
		noExternal: [/.*/],
		splitting: false,
		dts: false,
		banner: {
			js: "#!/usr/bin/env node",
		},
		outExtension: () => ({ js: ".js" }),
	},
]);
