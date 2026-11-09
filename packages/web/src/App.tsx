import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { Loader2 } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { RequireAuth } from "@/components/require-auth";

// Each route is its own chunk: a signer never downloads the sender console, and
// pdf.js only loads on pages that show a document.
const Dashboard = lazy(() => import("@/pages/dashboard"));
const EnvelopeDetail = lazy(() => import("@/pages/envelope-detail"));
const EnvelopeWizard = lazy(() => import("@/pages/wizard/envelope-wizard"));
const Webhooks = lazy(() => import("@/pages/webhooks"));
const Sign = lazy(() => import("@/pages/sign/sign-page"));
const NotFound = lazy(() => import("@/pages/not-found"));

function RouteFallback() {
  return (
    <div className="flex justify-center py-24 text-muted-foreground">
      <Loader2 className="size-5 animate-spin" aria-label="Loading" />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Public, token-authenticated signer page — its own minimal chrome. */}
        <Route path="/s/:token" element={<Sign />} />
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="new" element={<EnvelopeWizard />} />
          <Route path="envelopes/:id" element={<EnvelopeDetail />} />
          <Route path="envelopes/:id/edit" element={<EnvelopeWizard />} />
          <Route path="webhooks" element={<Webhooks />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
