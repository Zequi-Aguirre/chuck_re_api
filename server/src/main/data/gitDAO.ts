import { injectable } from "tsyringe";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

type ExecResult = { stdout: string; stderr: string; code?: number };

@injectable()
export default class GitDAO {
    private async runGit(args: string[], cwd: string): Promise<ExecResult> {
        const { stdout, stderr } = await execFileAsync("git", args, {
            cwd,
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        });

        return { stdout: stdout ?? "", stderr: stderr ?? "" };
    }

    async status(repoPath: string): Promise<ExecResult> {
        return await this.runGit(["status", "--porcelain=v1", "-b"], repoPath);
    }

    async diff(repoPath: string, filepath?: string): Promise<ExecResult> {
        if (filepath) {
            this.assertSafePath(filepath);
            return await this.runGit(["diff", "--", filepath], repoPath);
        }
        return await this.runGit(["diff"], repoPath);
    }

    async add(repoPath: string, filepath: string): Promise<ExecResult> {
        this.assertSafePath(filepath);
        return await this.runGit(["add", "--", filepath], repoPath);
    }

    async commit(repoPath: string, message: string): Promise<ExecResult> {
        if (!message || message.trim().length < 3) {
            throw new Error("Commit message too short");
        }

        return await this.runGit(["commit", "-m", message], repoPath);
    }

    async currentBranch(repoPath: string): Promise<string> {
        const r = await this.runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
        return r.stdout.trim();
    }

    async checkoutNewBranch(repoPath: string, branch: string): Promise<ExecResult> {
        this.assertSafeRef(branch);
        return await this.runGit(["checkout", "-b", branch], repoPath);
    }

    async checkoutBranch(repoPath: string, branch: string): Promise<ExecResult> {
        this.assertSafeRef(branch);
        return await this.runGit(["checkout", branch], repoPath);
    }

    async pushSetUpstream(repoPath: string, remote: string, branch: string): Promise<ExecResult> {
        this.assertSafeRef(remote);
        this.assertSafeRef(branch);
        return await this.runGit(["push", "-u", remote, branch], repoPath);
    }

    async pushCurrentBranch(repoPath: string, remote = "origin"): Promise<ExecResult> {
        this.assertSafeRef(remote);
        const branch = await this.currentBranch(repoPath);
        this.assertSafeRef(branch);
        return await this.runGit(["push", "-u", remote, branch], repoPath);
    }

    private assertSafePath(p: string): void {
        // Prevent obvious path traversal; repo sandboxing is enforced by cwd anyway.
        if (p.includes("..") || p.startsWith("/") || p.startsWith("~")) {
            throw new Error("Unsafe path");
        }
    }

    private assertSafeRef(ref: string): void {
        if (!/^[a-zA-Z0-9._\-\/]+$/.test(ref)) {
            throw new Error("Unsafe git ref");
        }
    }
}