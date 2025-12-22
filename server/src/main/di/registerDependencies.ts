import { container } from "tsyringe";

export const TOKENS = {
    ROOT_DIR: "ROOT_DIR",
} as const;

export const registerDependencies = (): void => {
    // Register primitive tokens here (strings, numbers, etc).
    // Tsyringe cannot infer these from TypeScript metadata.
    if (!container.isRegistered(TOKENS.ROOT_DIR)) {
        container.register(TOKENS.ROOT_DIR, { useValue: process.cwd() });
    }
};