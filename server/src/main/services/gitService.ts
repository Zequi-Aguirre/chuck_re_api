import { injectable } from "tsyringe";
import FsWorkspaceDAO from "../data/fsWorkspaceDAO";
import GitDAO from "../data/gitDAO";

export interface ExecResult {
    /** The command that was executed (for debugging/logging) */
    command: string;

    /** The standard output of the command */
    stdout: string;

    /** The standard error output (if any) */
    stderr: string;

    /** Exit code of the process (0 = success) */
    code: number;

    /** Whether the command succeeded */
    success: boolean;
}

@injectable()
export default class GitService {
    constructor(
        private readonly fsWorkspaceDAO: FsWorkspaceDAO,
        private readonly gitDao: GitDAO
    ) {}

    private async getRepoPathOrThrow(): Promise<string> {
        const { repoDir } = await this.fsWorkspaceDAO.getActiveRepoDirOrThrow();
        return repoDir;
    }

    async status() {
        const repoPath = await this.getRepoPathOrThrow();
        return await this.gitDao.status(repoPath);
    }

    async getDiff(filepath?: string) {
        const repoPath = await this.getRepoPathOrThrow();
        return await this.gitDao.diff(repoPath, filepath);
    }

    async addFile(input: any): Promise<ExecResult> {
        console.log("GitService.addFile input:", input);
        // Normalize payload like RepoService
        const filePath =
            input?.payload?.filePath ||
            input?.payload?.filepath || // backward compatibility
            input?.filePath ||
            input?.filepath ||
            (typeof input === "string" ? input : undefined);

        if (!filePath) throw new Error("Missing filePath in payload");

        console.log("Adding file to git:", filePath);
        const repoPath = await this.getRepoPathOrThrow();

        const result = await this.gitDao.add(repoPath, filePath);

        return {
            command: `git add ${filePath}`,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            code: result.code ?? 0,
            success: result.code === 0,
        };
    }

    async commit(input: { payload?: { message?: string }; message?: string }) {
        const message = input.payload?.message || input.message;
        if (!message || message.trim().length < 3) {
            throw new Error("Commit message too short");
        }

        const repoPath = await this.getRepoPathOrThrow();
        return await this.gitDao.commit(repoPath, message);
    }

    async getCurrentBranch() {
        const repoPath = await this.getRepoPathOrThrow();
        return await this.gitDao.currentBranch(repoPath);
    }

    async checkoutNewBranch(branch: string) {
        const repoPath = await this.getRepoPathOrThrow();
        return await this.gitDao.checkoutNewBranch(repoPath, branch);
    }

    async checkoutBranch(branch: string) {
        const repoPath = await this.getRepoPathOrThrow();
        return await this.gitDao.checkoutBranch(repoPath, branch);
    }

    async pushCurrentBranch(remote?: string) {
        const repoPath = await this.getRepoPathOrThrow();
        return await this.gitDao.pushCurrentBranch(repoPath, remote ?? "origin");
    }

    async push(input: { payload?: { remote?: string; branch?: string }; remote?: string; branch?: string }) {
        const remote = input.payload?.remote || input.remote || "origin";
        const branch = input.payload?.branch || input.branch;

        const repoPath = await this.getRepoPathOrThrow();

        if (branch) {
            console.log(`Pushing branch ${branch} to remote ${remote}`);
            return await this.gitDao.pushSetUpstream(repoPath, remote, branch);
        }

        console.log(`Pushing current branch to ${remote}`);
        return await this.gitDao.pushCurrentBranch(repoPath, remote);
    }
}