import type { ReactNode } from "react";

import { useAuth } from "@/lib/auth";
import SignIn from "@/pages/sign-in";

/** The sender console needs the API key; without one, show the key prompt. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { apiKey } = useAuth();
  return apiKey ? children : <SignIn />;
}
