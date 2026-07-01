import { container } from "tsyringe";
import { registerGhlEnrichment } from "../ghlEnrichment";

export const TOKENS = {
    ROOT_DIR: "ROOT_DIR",
} as const;

export const registerDependencies = (): void => {
    // Register primitive tokens here (strings, numbers, etc).
    // Tsyringe cannot infer these from TypeScript metadata.
    if (!container.isRegistered(TOKENS.ROOT_DIR)) {
        container.register(TOKENS.ROOT_DIR, { useValue: process.cwd() });
    }

    // GHL enrichment module wiring (SPEC: docs/ghl-enrichment).
    registerGhlEnrichment(container);
};