import express, { Request, Response, Router } from "express";
import { injectable } from "tsyringe";
import ProjectsService from "../services/projectsService";

@injectable()
export default class ProjectsResource {
    private readonly router: Router;

    constructor(private readonly projectsService: ProjectsService) {
        this.router = express.Router();
        this.initializeRoutes();
    }

    private initializeRoutes(): void {
        this.router.get("/", async (_req: Request, res: Response) => {
            const projects = await this.projectsService.listProjects();
            return res.status(200).json({ projects });
        });

        this.router.get("/active", async (_req: Request, res: Response) => {
            const active = await this.projectsService.getActive();
            return res.status(200).json(active);
        });

        this.router.post("/active", async (req: Request, res: Response) => {
            const { projectSlug, repoPath } = req.body as { projectSlug?: string | null; repoPath?: string | null };
            const active = await this.projectsService.setActive(projectSlug ?? null, repoPath ?? null);
            return res.status(200).json(active);
        });
    }

    routes(): Router {
        return this.router;
    }
}