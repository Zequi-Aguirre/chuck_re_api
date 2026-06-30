// Types for the Jake SMS assistant inbound webhook + core path.

/**
 * Payload posted by the single GHL automation to the inbound webhook.
 * Field names are accepted flexibly at the resource layer (e.g. message/body,
 * contactId/contact_id) and normalized into this shape.
 */
export type JakeInboundMessage = {
    contactId: string;
    message: string;
    /** Optional GHL number to send the reply from; omitted → location default. */
    fromNumber?: string;
};

export type JakeInboundResult = {
    ok: boolean;
    /** Normalized address parsed from the inbound message, if any. */
    address: string | null;
    /** The reply text that was sent back over SMS. */
    reply: string;
};
