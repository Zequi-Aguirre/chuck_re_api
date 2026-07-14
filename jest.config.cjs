/**
 * Jest config for the Jake server (introduced with JAK-102 — first unit tests).
 *
 * ts-jest transpiles each test with an explicit inline tsconfig so we don't
 * inherit the app's bundler-oriented options (noEmit / allowImportingTsExtensions),
 * while keeping the decorator metadata tsyringe relies on. reflect-metadata is
 * loaded before any test so @injectable-decorated classes import cleanly.
 */
module.exports = {
  testEnvironment: "node",
  // server holds the app's unit tests; client holds pure (no-DOM) UI-logic tests
  // such as the JAK-146 mobile-breakpoint helper.
  roots: ["<rootDir>/server", "<rootDir>/client"],
  testMatch: ["**/*.test.ts"],
  setupFiles: ["reflect-metadata"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          target: "es2022",
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          strict: true,
          skipLibCheck: true,
        },
      },
    ],
  },
};
