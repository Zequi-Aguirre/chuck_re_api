export type ActiveProjectState = {
    projectSlug: string | null;
    repoPath: string | null; // absolute path to git repo root
};

export type LoadContextResult = {
    system: string;      // _ai_docs concatenated
    runtime: string;     // active_context.md
    project?: string;    // optional: project PROJECT_MAP.md, rules.md, etc
};