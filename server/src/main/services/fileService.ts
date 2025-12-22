import { injectable } from "tsyringe";
import FsFileDAO from "../data/fsFileDAO";
import FsWorkspaceDAO from "../data/fsWorkspaceDAO";

@injectable()
export default class FileService {
    constructor(
        private readonly fsWorkspaceDAO: FsWorkspaceDAO,
        private readonly fsFileDAO: FsFileDAO
    ) {}

    private async repoDirOrThrow(): Promise<string> {
        const { repoDir } = await this.fsWorkspaceDAO.getActiveRepoDirOrThrow();
        return repoDir;
    }

    /**
     * Read a text file from the active repo.
     */
    async readFile(input: { path: string }) {
        const repoDir = await this.repoDirOrThrow();
        return await this.fsFileDAO.readFile(repoDir, input.path);
    }

    /**
     * Create a new file with optional initial content.
     */
    async createFile(input: { path: string; content?: string }) {
        const repoDir = await this.repoDirOrThrow();
        return await this.fsFileDAO.createFile(repoDir, input.path, input.content ?? "");
    }

    /**
     * Apply line-based patches to a file (startLine, endLine, newText).
     */
    async applyTextPatches(input: { path: string; patches: Array<{ startLine: number, endLine: number, newText: string }> }) {
        const repoDir = await this.repoDirOrThrow();
        return await this.fsFileDAO.applyPatches(repoDir, input.path, input.patches);
    }
}