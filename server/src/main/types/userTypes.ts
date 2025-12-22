import { Contact } from "./contactTypes.ts"; // or wherever you defined it

export type User = {
    id: string;
    contact_id: string;
    role: 'super_admin' | 'admin' | 'user' | 'guest';
    tier: 'free' | 'pro' | 'enterprise';
    api_key?: string;
    auth_provider?: 'email' | 'google' | string;

    is_active: boolean;

    contact: Contact; // Nested contact object (from joined query)

    created_at?: string;
    updated_at?: string;
    deleted_at?: string | null;
};

export type FrontEndUser = {
    email: string;
    id: string;
    name: string;
    role: string;
}

export type UserAuth = {
    id: string;
    email: string;
    email_confirmed_at: Date | null;
    created_at: Date;
    updated_at: Date;
};

export type Session = {
    token: string;
    user: FrontEndUser;
};

export type EncryptedPassword = {
    encrypted_password: string;
}

export type VerifyAuthCode = {
    is_authenticated: boolean;
    valid : boolean;
}

export type AuthTokenResponse = {
    access_token: string;
    user: Partial<User>;
    canAdmin?: { compass: boolean, sellersDirect: boolean, clientsDirect: boolean };
};
