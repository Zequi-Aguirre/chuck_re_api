import fs from "fs/promises";
import path from "path";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../di/registerDependencies";

export interface FunctionExecutionResult {
    status: "ok" | "error";
    result?: any;
    message?: string;
}

/**
 * Safe read/write DAO for global _ai_docs.
 * - Reads any .md file under _ai_docs/
 * - Writes only whitelisted files (starting with FUNCTION_REGISTRY.md)
 * - Prevents traversal outside _ai_docs
 * - UTF-8 only
 */
@injectable()
export default class FsDocsDAO {
    constructor(@inject(TOKENS.ROOT_DIR) private readonly rootDir: string) {}

    private aiDocsDir(): string {
        return path.resolve(this.rootDir, "_ai_docs");
    }

    private resolveSafePath(relPath: string): string {
        const abs = path.resolve(this.aiDocsDir(), relPath);
        if (!abs.startsWith(this.aiDocsDir())) {
            throw new Error("Path escape attempt blocked");
        }
        return abs;
    }

    async listDocs(): Promise<FunctionExecutionResult> {
        try {
            const entries = await fs.readdir(this.aiDocsDir(), { withFileTypes: true });
            const docs = entries
                .filter(e => e.isFile() && e.name.endsWith(".md"))
                .map(e => e.name);
            return { status: "ok", result: docs };
        } catch (err: any) {
            return { status: "error", message: err.message };
        }
    }

    async readFile(relPath: string): Promise<FunctionExecutionResult> {
        try {
            const abs = this.resolveSafePath(relPath);
            const content = await fs.readFile(abs, "utf8");
            return { status: "ok", result: content };
        } catch (err: any) {
            return { status: "error", message: err.message };
        }
    }

    async writeFile(relPath: string, content: string): Promise<FunctionExecutionResult> {
        try {
            const whitelist = ["FUNCTION_REGISTRY.md"];
            const abs = this.resolveSafePath(relPath);
            const filename = path.basename(abs);
            if (!whitelist.includes(filename)) {
                return { status: "error", message: `Write not allowed for ${filename}` };
            }
            await fs.writeFile(abs, content, "utf8");
            return { status: "ok", result: `${filename} updated` };
        } catch (err: any) {
            return { status: "error", message: err.message };
        }
    }
}