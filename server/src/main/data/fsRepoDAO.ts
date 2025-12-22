import fs from "fs/promises";
import path from "path";
import { execFile as execFileCallback } from "child_process";
import { promisify } from "util";

// ✅ Correctly typed promisified execFile using Node's built-in types
const execFile = promisify(execFileCallback) as (
    file: string,
    args?: ReadonlyArray<string> | null,
    options?: import("child_process").ExecFileOptions
) => Promise<{ stdout: string; stderr: string }>;

export default class FsRepoDAO {
    constructor() {}

    /**
     * Recursively list files and folders under the repository.
     */
    async tree(repoRoot: string, _opts = {}) {
        try {
            // use Git to get tracked files
            const { stdout } = await execFile("git", ["ls-files"], { cwd: repoRoot });
            const files = stdout.split("\n").filter(Boolean);

            // map to the format your UI expects
            return files.map((file) => ({
                name: path.basename(file),
                path: file,
                type: "file"
            }));
        } catch (err: any) {
            console.error("❌ [repoTree] Failed using git ls-files:", err.message);
            console.warn("⚠️ [repoTree] Falling back to recursive FS walk");

            // Fallback: walk the filesystem manually
            const result: any[] = [];

            const walk = async (dir: string): Promise<void> => {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const absPath = path.join(dir, entry.name);
                    const relPath = path.relative(repoRoot, absPath);
                    const node: any = {
                        name: entry.name,
                        path: relPath,
                        type: entry.isDirectory() ? "dir" : "file",
                    };
                    result.push(node);
                    if (entry.isDirectory()) await walk(absPath);
                }
            };

            await walk(repoRoot);
            return result;
        }
    }

    /**
     * Read a single file with size limits.
     */
    async readFile(repoRoot: string, relativePath: string, opts: { maxBytes?: number } = {}) {
        const { maxBytes = 200_000 } = opts;
        const absPath = path.join(repoRoot, relativePath);
        const stat = await fs.stat(absPath);

        if (stat.size > maxBytes) {
            throw new Error(`File too large to read (${stat.size} bytes, limit ${maxBytes})`);
        }

        const content = await fs.readFile(absPath, "utf8");
        return { path: relativePath, content, size: stat.size };
    }

    /**
     * Text search across files in the repository.
     */
    async search(
        repoRoot: string,
        opts: { query: string; basePath?: string; maxFiles?: number; maxMatches?: number; maxFileBytes?: number }
    ) {
        const { query, basePath = ".", maxFiles = 800, maxMatches = 200, maxFileBytes = 500_000 } = opts;
        const baseAbs = path.join(repoRoot, basePath);
        const matches: any[] = [];
        let filesScanned = 0;

        async function walk(dir: string) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (matches.length >= maxMatches || filesScanned >= maxFiles) return;
                const absPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(absPath);
                } else {
                    try {
                        const stat = await fs.stat(absPath);
                        if (stat.size <= maxFileBytes) {
                            const content = await fs.readFile(absPath, "utf8");
                            const lines = content.split(/\r?\n/);
                            lines.forEach((line, i) => {
                                if (line.includes(query)) {
                                    matches.push({
                                        path: path.relative(repoRoot, absPath),
                                        line: i + 1,
                                        preview: line.slice(0, 240),
                                    });
                                }
                            });
                        }
                        filesScanned++;
                    } catch {}
                }
            }
        }

        await walk(baseAbs);
        return { matches, filesScanned };
    }

    /**
     * Apply a unified diff patch using Git itself.
     * This completely replaces the manual JS hunk-based logic.
     */
    async applyPatch(repoRoot: string, patchText: string) {
        const tmpPatchPath = path.join(repoRoot, ".askzack_tmp_patch.diff");

        console.log("🟡 [git apply] Starting patch");
        console.log("repoRoot:", repoRoot);

        // 🧠 Check if Git is installed before proceeding
        try {
            await execFile("git", ["--version"]);
        } catch {
            throw new Error("Git is not installed or not available in PATH.");
        }

        try {
            // 1️⃣ Write the patch to a temp file
            await fs.writeFile(tmpPatchPath, patchText, "utf8");
            console.log("📄 Temp patch file written:", tmpPatchPath);

            // 2️⃣ Execute git apply safely
            const { stdout, stderr } = await execFile(
                "git",
                ["apply", "--whitespace=fix", "--verbose", tmpPatchPath],
                { cwd: repoRoot }
            );

            console.log("✅ [git apply] Completed successfully");
            if (stdout.trim()) console.log("🧩 stdout:\n", stdout);
            if (stderr.trim()) console.warn("⚠️ stderr:\n", stderr);

            // 3️⃣ Extract file names for response
            const filesChanged = this.extractChangedFiles(patchText);
            console.log("📦 Files changed:", filesChanged);

            return { status: "ok", filesChanged };
        } catch (err: any) {
            console.warn("⚠️ [git apply] Failed — attempting hybrid fallback:", err.message);

            const filesChanged = this.extractChangedFiles(patchText);

            for (const relPath of filesChanged) {
                const absPath = path.join(repoRoot, relPath);

                // ✅ Only fallback for Markdown and text files
                if (/\.(md|txt|markdown)$/i.test(relPath)) {
                    console.warn(`🧩 [fallback] Writing file directly: ${relPath}`);

                    try {
                        const contentLines = patchText
                            .split("\n")
                            .filter(line => line.startsWith("+") && !line.startsWith("+++"))
                            .map(line => line.substring(1));
                        const content = contentLines.join("\n");

                        await fs.mkdir(path.dirname(absPath), { recursive: true });
                        await fs.writeFile(absPath, content, "utf8");
                        console.log(`✅ [fallback] Successfully wrote ${relPath}`);
                    } catch (fallbackErr: any) {
                        console.error(`❌ [fallback] Could not write ${relPath}:`, fallbackErr.message);
                    }
                } else {
                    console.error(`❌ [fallback] Skipped non-Markdown file: ${relPath}`);
                }
            }

            return { status: "ok", filesChanged, fallback: true };
        } finally {
            // 4️⃣ Clean up temp file
            try {
                await fs.unlink(tmpPatchPath);
                console.log("🧹 Temp patch file removed");
            } catch {
                console.warn("⚠️ Could not remove temp patch file");
            }
        }
    }

    /**
     * Create a new file if it does not exist.
     */
    async createFileIfMissing(repoRoot: string, relativePath: string, content = "") {
        const absPath = path.join(repoRoot, relativePath);
        try {
            await fs.access(absPath);
            console.log(`⚠️ File already exists: ${relativePath}`);
            return { created: false, message: "File already exists", path: relativePath };
        } catch {
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            await fs.writeFile(absPath, content, "utf8");
            console.log(`✅ Created new file: ${relativePath}`);
            return { created: true, path: relativePath };
        }
    }

    /**
     * Edit one or more text segments in a file, replacing specified line ranges.
     * Supports multiple disjoint patches in one call.
     */
    async editFileSegments(
        repoRoot: string,
        relativePath: string,
        edits: Array<{ startLine: number; endLine: number; newText: string }>
    ) {
        const absPath = path.join(repoRoot, relativePath);
        let content = "";

        try {
            content = await fs.readFile(absPath, "utf8");
        } catch {
            console.warn(`⚠️ File not found, creating new one: ${relativePath}`);
            await fs.mkdir(path.dirname(absPath), { recursive: true });
        }

        const lines = content ? content.split(/\r?\n/) : [];

        // Sort edits from bottom to top to avoid index shifting
        const sorted = [...edits].sort((a, b) => b.startLine - a.startLine);

        for (const { startLine, endLine, newText } of sorted) {
            const newLines = newText.split(/\r?\n/);
            // ✅ Replace only the targeted range, not the entire file
            lines.splice(startLine - 1, endLine - startLine + 1, ...newLines);
        }

        const newContent = lines.join("\n");
        await fs.writeFile(absPath, newContent, "utf8");

        console.log(`✅ Edited file: ${relativePath} (${edits.length} patches)`);
        return { edited: true, patches: edits.length, path: relativePath };
    }

    /**
     * Extract changed file names from a diff string.
     */
    private extractChangedFiles(patchText: string): string[] {
        const matches = [...patchText.matchAll(/^diff --git a\/(.+?) b\/\1/mg)];
        return matches.map((m) => m[1]);
    }
}