export type CustomGptSchema = {
    id: string;
    assistant_id: string;       // references assistants.id
    version: string;            // e.g., 'v1', 'v2', etc.
    schema: Record<string, any>; // OpenAPI JSON schema
    active: boolean;
    created_at: string;         // ISO timestamp string
};