import { injectable } from "tsyringe";
import FsContextDAO from "../data/fsContextDAO";
import { LoadContextResult } from "../types/contextTypes";

@injectable()
export default class ContextService {
    constructor(private readonly fsDao: FsContextDAO) {}

    async bootstrap(): Promise<void> {
        await this.fsDao.ensureBootstrapFiles();
    }

    async loadContext(): Promise<LoadContextResult> {
        const system = await this.fsDao.readAllAiDocs();
        const runtime = await this.fsDao.readActiveContext();

        const active = await this.fsDao.getActiveProjectState();
        let project: string | undefined;

        if (active.projectSlug) {
            // Minimal project context. Expand later.
            const projectMap = await this.fsDao.readProjectFile(active.projectSlug, "PROJECT_MAP.md");
            const rules = await this.fsDao.readProjectFile(active.projectSlug, "rules.md");
            project = [projectMap, rules].filter(Boolean).join("\n\n");
        }

        return { system, runtime, project };
    }

    async updateActiveContext(content: string): Promise<void> {
        await this.fsDao.writeActiveContext(content);
    }
}