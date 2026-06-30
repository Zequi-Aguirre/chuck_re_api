// server/src/main/types/Mailer.ts

import { MailerEnrichmentResponse } from "./RealEstateApi.ts";

export type MailerEnrichPropertyRequest = {
    address: string;
};

export type MailerEnrichPropertyResult = {
    ok: boolean;
    address: string;
    result: MailerEnrichmentResponse | null;
};