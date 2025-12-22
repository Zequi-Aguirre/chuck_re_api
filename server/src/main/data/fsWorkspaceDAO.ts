import fs from "fs/promises";
import path from "path";
import { inject, injectable } from "tsyringe";
import { ActiveWorkspaceState, WorkspaceMeta } from "../types/workspaceTypes";
import { TOKENS } from "../di/registerDependencies";

@injectable()
export default class FsWorkspaceDAO {
    constructor(@inject(TOKENS.ROOT_DIR) private readonly rootDir: string) {}

    private dbRoot(): string {
        return path.resolve(this.rootDir, "_askzack_db");
    }

    private contextDir(): string {
        return path.join(this.dbRoot(), "_context");
    }

    private workspacesDir(): string {
        return path.join(this.dbRoot(), "workspaces");
    }

    private activePath(): string {
        return path.join(this.contextDir(), "active_workspace.json");
    }

    async ensureWorkspaceBootstrap(): Promise<void> {
        await fs.mkdir(this.contextDir(), { recursive: true });
        await fs.mkdir(this.workspacesDir(), { recursive: true });

        try {
            await fs.access(this.activePath());
        } catch {
            const initial: ActiveWorkspaceState = { workspaceId: null };
            await fs.writeFile(this.activePath(), JSON.stringify(initial, null, 2), "utf8");
        }
    }

    private workspaceDir(workspaceId: string): string {
        return path.join(this.workspacesDir(), workspaceId);
    }

    async createWorkspaceFolders(workspaceId: string): Promise<{ workspaceDir: string }> {
        const workspaceDir = this.workspaceDir(workspaceId);
        await fs.mkdir(workspaceDir, { recursive: true });
        return { workspaceDir };
    }

    async writeWorkspaceMeta(workspaceId: string, meta: WorkspaceMeta): Promise<void> {
        const metaPath = path.join(this.workspaceDir(workspaceId), "meta.json");
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
    }

    async readWorkspaceMeta(workspaceId: string): Promise<WorkspaceMeta | null> {
        try {
            const metaPath = path.join(this.workspaceDir(workspaceId), "meta.json");
            const raw = await fs.readFile(metaPath, "utf8");
            return JSON.parse(raw) as WorkspaceMeta;
        } catch {
            return null;
        }
    }

    async listWorkspaceIds(): Promise<string[]> {
        const entries = await fs.readdir(this.workspacesDir(), { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    }

    async setActiveWorkspace(workspaceId: string | null): Promise<void> {
        const next: ActiveWorkspaceState = { workspaceId };
        await fs.writeFile(this.activePath(), JSON.stringify(next, null, 2), "utf8");
    }

    async getActiveWorkspaceState(): Promise<ActiveWorkspaceState> {
        const raw = await fs.readFile(this.activePath(), "utf8");
        return JSON.parse(raw) as ActiveWorkspaceState;
    }

    /**
     * Active workspace repo path (attached mode).
     * We return repoPath from meta, NOT _askzack_db/workspaces/<id>/repo.
     */
    async getActiveRepoDirOrThrow(): Promise<{ workspaceId: string; repoDir: string }> {
        const active = await this.getActiveWorkspaceState();
        if (!active.workspaceId) {
            throw new Error("No active workspace set");
        }

        const meta = await this.readWorkspaceMeta(active.workspaceId);
        if (!meta) {
            throw new Error("Active workspace meta not found");
        }

        const repoDir = (meta as any).repoPath as string | undefined;
        if (!repoDir) {
            throw new Error("Active workspace missing repoPath");
        }

        console.log("Active workspace repoDir:", repoDir);
        return { workspaceId: active.workspaceId, repoDir };
    }
}