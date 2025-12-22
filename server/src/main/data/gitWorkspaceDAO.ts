import { injectable } from "tsyringe";
import fs from "fs";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";

@injectable()
export default class GitWorkspaceDAO {
    async clone(repoUrl: string, repoDir: string, defaultBranch: string): Promise<void> {
        // shallow clone for speed
        await git.clone({
            fs,
            http,
            dir: repoDir,
            url: repoUrl,
            ref: defaultBranch,
            singleBranch: true,
            depth: 1,
        });
    }

    async status(repoDir: string) {
        return await git.statusMatrix({ fs, dir: repoDir });
    }

    async diff(repoDir: string, filepath?: string) {
        return await git.diff({ fs, dir: repoDir, filepath });
    }
}