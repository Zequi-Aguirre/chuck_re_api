import { Router, Request, Response } from "express";
import { injectable } from "tsyringe";
import { MailerService } from "../services/MailerService.ts";
import { MailerEnrichPropertyRequest } from "../types/Mailer.ts";

@injectable()
export class MailerResource {
    public readonly router: Router;

    constructor(private readonly mailerService: MailerService) {
        this.router = Router();
        this.configureRoutes();
    }

    private configureRoutes(): void {
        this.router.post("/enrich-property", this.enrichProperty.bind(this));
    }

    private async enrichProperty(req: Request, res: Response): Promise<Response> {
        try {
            console.log("➡️ MailerResource.enrichProperty called with body:", req.body);
            const { address } = req.body as MailerEnrichPropertyRequest;

            if (!address || !String(address).trim()) {
                return res.status(400).json({
                    ok: false,
                    error: "Missing required field: address",
                });
            }

            const result = await this.mailerService.enrichProperty({
                address: String(address).trim(),
            });

            return res.status(200).json(result);
        } catch (err) {
            console.error("❌ MailerResource.enrichProperty error:", err);
            return res.status(500).json({
                ok: false,
                error: "Internal Server Error",
            });
        }
    }
}