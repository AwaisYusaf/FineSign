import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { api, UNAUTHORIZED_EVENT } from "@/lib/api";
import { AuthContext } from "@/lib/auth";
import { readApiKey, writeApiKey } from "@/lib/config";

/** Holds the sender API key; signs out when the server starts rejecting it. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState(readApiKey);
  const [notice, setNotice] = useState<string | null>(null);

  const signOut = useCallback(
    (why?: string) => {
      writeApiKey("");
      setApiKey("");
      setNotice(why ?? null);
      queryClient.clear(); // never show one key's data to the next
    },
    [queryClient]
  );

  const signIn = useCallback(async (key: string) => {
    await api.checkApiKey(key); // throws ApiError(401) for a wrong key
    writeApiKey(key);
    setApiKey(key);
    setNotice(null);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => signOut("The server no longer accepts that API key. Enter the current one.");
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [signOut]);

  const value = useMemo(() => ({ apiKey, notice, signIn, signOut }), [apiKey, notice, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
