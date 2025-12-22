import * as esbuild from 'esbuild'
import esbuildPluginTsc from "esbuild-plugin-tsc";

await esbuild.build({
    logLevel: "verbose",
    entryPoints: ["server/src/main/server.ts"],
    bundle: true,
    platform: "node",
    target: "node18",
    outdir: "dist",
    tsconfig: "server/tsconfig.json",
    plugins: [
        // run ts files through tsc so that we pick up decorators
        esbuildPluginTsc({
            // TODO not sure if both esbuild and this need it
            tsconfigPath: "server/tsconfig.json",
            force: true,
            tsx: true
        })
    ],
})