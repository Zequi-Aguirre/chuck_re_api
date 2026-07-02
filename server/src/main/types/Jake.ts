// Types for the Jake SMS assistant inbound webhook + core path.

/**
 * A normalized inbound text, already resolved to the tenant it belongs to.
 * The resource layer accepts GHL's flexible field names (message/body,
 * contactId/contact_id, locationId/location_id) and — critically — resolves
 * `locationId` to a known connection BEFORE building this shape, so the
 * assistant only ever acts for a confirmed tenant (JAK-114).
 */
export type JakeInboundMessage = {
    /** Resolved GHL sub-account (location) whose credentials handle this text. */
    locationId: string;
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
