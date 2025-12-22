import { injectable } from "tsyringe";
import FsContextDAO from "../data/fsContextDAO";
import { ActiveProjectState } from "../types/contextTypes";

@injectable()
export default class ProjectsService {
    constructor(private readonly fsDao: FsContextDAO) {}

    async listProjects(): Promise<string[]> {
        return await this.fsDao.listProjectSlugs();
    }

    async getActive(): Promise<ActiveProjectState> {
        return await this.fsDao.getActiveProjectState();
    }

    async setActive(projectSlug: string | null, repoPath: string | null): Promise<ActiveProjectState> {
        const next: ActiveProjectState = { projectSlug, repoPath };
        await this.fsDao.setActiveProjectState(next);
        return next;
    }
}