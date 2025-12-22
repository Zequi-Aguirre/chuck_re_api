export type RegisteredUser = {
    registered: boolean
    user_id?: string
}

export type AuthCode = {
    auth_code: string
}

export type AuthCodeStatus =
    | 'not_found'
    | 'link_expired'
    | 'already_registered'
    | 'auth_code_mismatch'
    | 'valid';
