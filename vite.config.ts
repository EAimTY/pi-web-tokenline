// The library-mode build for the browser entry. PI WEB serves everything inside
// `browserRoot` (`dist/`) verbatim and never compiles installed plugin source
// (`docs/plugins.md`, "Install and manage"), so this output is the package's runtime
// artifact and is committed: `npm run verify:dist` fails when it drifts from `src/`.
//
// `base` stays relative and assets are never inlined, because the host serves the
// plugin from a revisioned subpath and a stylesheet contribution must be a real
// HTTP(S) URL, not a `data:` payload.

import { defineConfig } from "vite";

export default defineConfig({
    base: "./",
    build: {
        target: "es2022",
        outDir: "dist",
        emptyOutDir: true,
        assetsInlineLimit: 0,
        minify: false,
        lib: {
            entry: "src/pi-web-plugin.ts",
            formats: [
                "es",
            ],
            fileName: () => "pi-web-plugin.js",
        },
        rollupOptions: {
            output: {
                assetFileNames: "[name][extname]",
            },
        },
    },
});
