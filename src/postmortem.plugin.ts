import { postmortemPlugin } from "./index";

// Bundled entry used for the fallback plugin bundle. Export only the
// plugin function as the default export so OpenCode treats it as a
// single plugin factory and doesn't attempt to call non-function
// exports.
export default postmortemPlugin;
