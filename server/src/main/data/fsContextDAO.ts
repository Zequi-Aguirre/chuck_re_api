import fs from "fs/promises";
import path from "path";
import { injectable } from "tsyringe";
import { ActiveProjectState } from "../types/contextTypes";

@injectable()
export default class FsContextDAO {
    constructor(
    ) {}

    private aiDocsDir(): string {
        return path.resolve('this.rootDir', "_ai_docs");
    }

    private dbDir(): string {
        return path.resolve('this.rootDir', "_askzack_db");
    }

    private runtimeDir(): string {
        return path.resolve(this.dbDir(), "_context");
    }

    private projectsDir(): string {
        return path.resolve(this.dbDir(), "projects");
    }

    async ensureBootstrapFiles(): Promise<void> {
        await fs.mkdir(this.aiDocsDir(), { recursive: true });
        await fs.mkdir(this.runtimeDir(), { recursive: true });
        await fs.mkdir(this.projectsDir(), { recursive: true });

        await this.ensureFile(path.join(this.aiDocsDir(), "identity.md"), "# AskZack Identity\n");
        await this.ensureFile(path.join(this.aiDocsDir(), "behavior_rules.md"), "# Behavior Rules\n");
        await this.ensureFile(path.join(this.aiDocsDir(), "project_behavior.md"), "# Project Behavior\n");

        await this.ensureFile(path.join(this.runtimeDir(), "active_context.md"), "# Active Context\n");

        const statePath = path.join(this.runtimeDir(), "active_project.json");
        try {
            await fs.access(statePath);
        } catch {
            const initial: ActiveProjectState = { projectSlug: null, repoPath: null };
            await fs.writeFile(statePath, JSON.stringify(initial, null, 2), "utf8");
        }
    }

    private async ensureFile(filePath: string, defaultContent: string): Promise<void> {
        try {
            await fs.access(filePath);
        } catch {
            await fs.writeFile(filePath, defaultContent, "utf8");
        }
    }

    async readAllAiDocs(): Promise<string> {
        return await this.concatMarkdownRecursive(this.aiDocsDir());
    }

    async readActiveContext(): Promise<string> {
        const p = path.join(this.runtimeDir(), "active_context.md");
        return await fs.readFile(p, "utf8");
    }

    async writeActiveContext(content: string): Promise<void> {
        const p = path.join(this.runtimeDir(), "active_context.md");
        await fs.writeFile(p, content, "utf8");
    }

    async listProjectSlugs(): Promise<string[]> {
        const entries = await fs.readdir(this.projectsDir(), { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => e.name);
    }

    async getActiveProjectState(): Promise<ActiveProjectState> {
        const p = path.join(this.runtimeDir(), "active_project.json");
        const raw = await fs.readFile(p, "utf8");
        return JSON.parse(raw) as ActiveProjectState;
    }

    async setActiveProjectState(state: ActiveProjectState): Promise<void> {
        const p = path.join(this.runtimeDir(), "active_project.json");
        await fs.writeFile(p, JSON.stringify(state, null, 2), "utf8");
    }

    async readProjectFile(projectSlug: string, relPath: string): Promise<string | null> {
        const safeRoot = path.join(this.projectsDir(), projectSlug);
        const abs = path.resolve(safeRoot, relPath);
        if (!abs.startsWith(safeRoot)) {
            throw new Error("Path escape attempt blocked");
        }
        try {
            return await fs.readFile(abs, "utf8");
        } catch {
            return null;
        }
    }

    private async concatMarkdownRecursive(dir: string): Promise<string> {
        const files: string[] = [];
        const walk = async (d: string): Promise<void> => {
            const entries = await fs.readdir(d, { withFileTypes: true });
            for (const e of entries) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) {
                    await walk(p);
                } else if (p.endsWith(".md")) {
                    files.push(p);
                }
            }
        };

        await walk(dir);

        let out = "";
        for (const filePath of files.sort()) {
            out += "\n\n" + (await fs.readFile(filePath, "utf8"));
        }
        return out.trim();
    }
}