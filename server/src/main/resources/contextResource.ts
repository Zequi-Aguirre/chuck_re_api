import express, { Request, Response, Router } from "express";
import { injectable } from "tsyringe";
import ContextService from "../services/contextService";

@injectable()
export default class ContextResource {
    private readonly router: Router;

    constructor(private readonly contextService: ContextService) {
        this.router = express.Router();
        this.initializeRoutes();
    }

    private initializeRoutes(): void {
        this.router.get("/load", async (_req: Request, res: Response) => {
            try {
                const context = await this.contextService.loadContext();
                return res.status(200).json(context);
            } catch (err) {
                console.error("Error loading context:", err);
                return res.status(500).json({ message: "Failed to load context" });
            }
        });

        this.router.put("/active", async (req: Request, res: Response) => {
            try {
                const { content } = req.body as { content?: string };
                if (typeof content !== "string") {
                    return res.status(400).json({ message: "content is required" });
                }
                await this.contextService.updateActiveContext(content);
                return res.status(200).json({ ok: true });
            } catch (err) {
                console.error("Error writing active context:", err);
                return res.status(500).json({ message: "Failed to write active context" });
            }
        });
    }

    routes(): Router {
        return this.router;
    }
}