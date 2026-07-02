import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { api, UnauthorizedError } from "./api";
import { AdminUser } from "./types";

interface AuthState {
  user: AdminUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Session state for the admin SPA. On mount it asks the server "who am I?"
 * (`GET /auth/me`) using the httpOnly cookie; the SPA never holds the raw token.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api
      .me()
      .then((u) => active && setUser(u))
      .catch((err) => {
        if (!(err instanceof UnauthorizedError)) console.error(err);
        if (active) setUser(null);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login: async (email, password) => setUser(await api.login(email, password)),
      logout: async () => {
        await api.logout();
        setUser(null);
      },
    }),
    [user, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
