export type Contact = {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    note?: string | null;

    created_at?: string; // ISO timestamp (from Supabase)
    updated_at?: string;
    deleted_at?: string | null;
};