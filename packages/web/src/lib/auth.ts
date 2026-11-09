import { createContext, useContext } from "react";

export interface AuthState {
  /** The sender API key in use, or "" when signed out. */
  apiKey: string;
  /** Why the user was signed out, when it wasn't their choice. */
  notice: string | null;
  /** Check the key against the server, then keep it. Throws ApiError if rejected. */
  signIn: (key: string) => Promise<void>;
  signOut: (notice?: string) => void;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
