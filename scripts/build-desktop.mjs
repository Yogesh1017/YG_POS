// Bundles the desktop shell and the core into plain JavaScript files that Electron (or Node) can run.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: false, logLevel: "info", external: ["electron"] };
await build({ ...common, entryPoints: ["desktop/main.ts"], outfile: "dist-desktop/main.js" });
await build({ ...common, entryPoints: ["desktop/preload.ts"], outfile: "dist-desktop/preload.js" });
await build({ ...common, entryPoints: ["desktop/dev-server.ts"], outfile: "dist-desktop/dev-server.js" });
