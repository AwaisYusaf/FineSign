import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "@fontsource-variable/inter";
// The signature fonts finesign-core stamps with, self-hosted (no CDN), so the
// typed-signature preview looks exactly like the stamped PDF.
import "@fontsource/great-vibes";
import "@fontsource/dancing-script";
import "@fontsource/pacifico";
import "@fontsource/pinyon-script";
import "./index.css";

import App from "@/App";
import { AuthProvider } from "@/components/auth-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx will not fix itself by retrying (wrong key, missing envelope).
      retry: (failures, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <TooltipProvider delayDuration={300}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
            <Toaster position="top-center" />
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
);
