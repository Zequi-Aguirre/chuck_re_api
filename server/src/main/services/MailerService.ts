// server/src/main/services/MailerService.ts

import { injectable } from "tsyringe";
import { RealEstateApiDao } from "../data/RealEstateApiDao.ts";
import {
    MailerEnrichPropertyRequest,
    MailerEnrichPropertyResult,
} from "../types/Mailer.ts";

@injectable()
export class MailerService {
    constructor(private readonly realEstateDao: RealEstateApiDao) {}

    public async enrichProperty(
        input: MailerEnrichPropertyRequest
    ): Promise<MailerEnrichPropertyResult> {
        const address = String(input.address ?? "").trim();

        if (!address) {
            return {
                ok: false,
                address: "",
                result: null,
            };
        }

        const result = await this.realEstateDao.getMailerEnrichmentByAddress(address);

        return {
            ok: true,
            address,
            result,
        };
    }
}