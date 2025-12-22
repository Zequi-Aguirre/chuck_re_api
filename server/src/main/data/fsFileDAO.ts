import fs from "fs/promises";
import path from "path";

export default class FsFileDAO {
    private resolvePath(repoRoot: string, relativePath: string) {
        return path.join(repoRoot, relativePath);
    }

    async readFile(repoRoot: string, relativePath: string) {
        const absPath = this.resolvePath(repoRoot, relativePath);
        const content = await fs.readFile(absPath, "utf8");
        const stats = await fs.stat(absPath);
        return { path: relativePath, content, size: stats.size };
    }

    async createFile(repoRoot: string, relativePath: string, content = "") {
        const absPath = this.resolvePath(repoRoot, relativePath);
        try {
            await fs.access(absPath);
            throw new Error(`File already exists: ${relativePath}`);
        } catch {
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            await fs.writeFile(absPath, content, "utf8");
            return { path: relativePath, created: true };
        }
    }

    async applyPatches(repoRoot: string, relativePath: string, patches: Array<{ startLine: number, endLine: number, newText: string }>) {
        const absPath = this.resolvePath(repoRoot, relativePath);
        const original = await fs.readFile(absPath, "utf8");
        const lines = original.split("\n");
        const sorted = patches.sort((a, b) => a.startLine - b.startLine);
        let newContent = "";
        let currentLine = 1;

        for (const patch of sorted) {
            const before = lines.slice(currentLine - 1, patch.startLine - 1).join("\n");
            newContent += before + (before ? "\n" : "");
            newContent += patch.newText;
            currentLine = patch.endLine + 1;
            if (currentLine <= lines.length) newContent += "\n";
        }

        if (currentLine <= lines.length) {
            newContent += lines.slice(currentLine - 1).join("\n");
        }

        await fs.writeFile(absPath, newContent, "utf8");
        return { path: relativePath, patches: patches.length, success: true };
    }
}