import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";

import { Logo } from "@/components/logo";
import { ModeToggle } from "@/components/mode-toggle";

/** The signer's chrome: no console navigation, just who's asking and that it's secure. */
export function SignerFrame({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className={`mx-auto flex h-14 items-center gap-3 px-4 sm:px-6 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>
          <Logo />
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
              <ShieldCheck className="size-3.5" /> Secure signing link
            </span>
            <ModeToggle />
          </div>
        </div>
      </header>
      <main className={`mx-auto w-full flex-1 px-4 py-8 sm:px-6 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>{children}</main>
      <footer className="pb-6 text-center text-xs text-muted-foreground">
        Every action is recorded in a tamper-evident audit trail.
      </footer>
    </div>
  );
}
