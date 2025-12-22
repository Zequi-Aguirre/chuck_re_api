import { injectable } from "tsyringe";
import FsWorkspaceDAO from "../data/fsWorkspaceDAO";
import FsRepoDAO from "../data/fsRepoDAO";

interface FileEditPatch {
    startLine: number;
    endLine: number;
    newText: string;
}

interface FileEdit {
    filePath: string;
    patches: FileEditPatch[];
}

@injectable()
export default class RepoService {
    constructor(
        private readonly fsWorkspaceDAO: FsWorkspaceDAO,
        private readonly fsRepoDAO: FsRepoDAO
    ) {}

    private async repoDirOrThrow(): Promise<string> {
        const { repoDir } = await this.fsWorkspaceDAO.getActiveRepoDirOrThrow();
        return repoDir;
    }

    /**
     * 🧭 List repo files
     */
    async tree(input: { payload: { basePath?: string; maxDepth?: number; maxEntries?: number; includeSizes?: boolean } }) {
        const { basePath, maxDepth = 6, maxEntries = 3000, includeSizes = false } = input.payload;
        const repoDir = await this.repoDirOrThrow();
        return await this.fsRepoDAO.tree(repoDir, { basePath, maxDepth, maxEntries, includeSizes });
    }

    /**
     * 📖 Read a file
     */
    async read(input: { payload?: { path?: string }; query?: { path?: string }; path?: string }) {
        console.log("RepoService.read called with input:", input);
        // support both GET and POST shapes
        const path =
            input.payload?.path ||
            input.query?.path ||
            input.path ||
            (typeof (input as any).path === "string" ? (input as any).path : undefined);

        if (!path) throw new Error("Missing path in payload");

        const repoDir = await this.repoDirOrThrow();
        return await this.fsRepoDAO.readFile(repoDir, path, { maxBytes: 200_000 });
    }

    /**
     * 🔍 Search for a term in the repo
     */
    async search(input: { payload: { query: string; basePath?: string } }) {
        const { query, basePath } = input.payload;
        const repoDir = await this.repoDirOrThrow();
        return await this.fsRepoDAO.search(repoDir, {
            query,
            basePath,
            maxFiles: 800,
            maxMatches: 200,
            maxFileBytes: 500_000
        });
    }

    /**
     * 🪶 Apply a Git patch string
     */
    async applyPatch(input: { payload: { patch: string } }) {
        const { patch } = input.payload;
        const repoDir = await this.repoDirOrThrow();
        return await this.fsRepoDAO.applyPatch(repoDir, patch);
    }

    /**
     * 📄 Create a new file (if missing)
     */
    async createFile(input: { payload: { filePath: string; content?: string } }) {
        const { filePath, content = "" } = input.payload;
        if (!filePath) throw new Error("Missing filePath in payload");
        const repoDir = await this.repoDirOrThrow();
        const result = await this.fsRepoDAO.createFileIfMissing(repoDir, filePath, content);
        return { status: "ok", result };
    }

    /**
     * ✏️ Edit file segments directly (multi-patch safe)
     */
    async textEdit(input: { payload: { edits: FileEdit[] } }) {
        const { edits } = input.payload;
        if (!Array.isArray(edits)) throw new Error("Missing or invalid edits array in payload");

        const repoDir = await this.repoDirOrThrow();
        const results = [];
        for (const edit of edits) {
            const result = await this.fsRepoDAO.editFileSegments(repoDir, edit.filePath, edit.patches);
            results.push(result);
        }

        return { status: "ok", result: results };
    }
}