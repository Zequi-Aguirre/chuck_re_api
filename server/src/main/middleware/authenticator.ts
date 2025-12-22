import { Request, Response, NextFunction } from "express";
import { injectable } from "tsyringe";
import { UNAUTHORIZED } from "../types/customHTTPCode";
import { User as DBUser } from "../types/userTypes";

declare module "express-serve-static-core" {
    interface Request {
        user: DBUser;
        assistantId?: string;
        apiKey: string;
    }
}

@injectable()
export class Authenticator {
    constructor() {}

    async authenticateApiKey(req: Request, res: Response, next: NextFunction) {
        const apiKey = req.headers["x-api-key"];
        if (!apiKey) {
            return res.status(UNAUTHORIZED).json({ message: "API key missing" });
        }

        // TODO if EnvConfig master api key is not the key provided, reject

        req.apiKey = apiKey as string;
        next(); // AskZoe will do the actual validation
    }

    authenticateApiKeyFunc() {
        return (req: Request, res: Response, next: NextFunction) => {
            return this.authenticateApiKey(req, res, next);
        };
    }
}