export type WorkspaceMeta = {
    workspaceId: string;
    createdAt: string;
    mode: "attached";
    repoPath: string;
};

export type ActiveWorkspaceState = {
    workspaceId: string | null;
};