import { Suspense } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { FileSignature, KeyRound, Loader2, Plus, Webhook } from "lucide-react";

import { Logo } from "@/components/logo";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Envelopes", icon: FileSignature, end: true },
  { to: "/webhooks", label: "Webhooks", icon: Webhook, end: false },
];

/** The sender console frame: top bar with navigation, then the page. */
export function AppShell() {
  const { signOut } = useAuth();
  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:gap-6 sm:px-6">
          <Link to="/" className="shrink-0 rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
            <Logo />
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    isActive && "bg-accent text-foreground"
                  )
                }
              >
                <Icon className="size-4" />
                <span className="hidden sm:inline">{label}</span>
                <span className="sr-only sm:hidden">{label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <Button asChild size="sm" className="hidden sm:inline-flex">
              <Link to="/new">
                <Plus /> New envelope
              </Link>
            </Button>
            <Button asChild size="icon-sm" className="sm:hidden" aria-label="New envelope">
              <Link to="/new">
                <Plus />
              </Link>
            </Button>
            <ModeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Account">
                  <KeyRound className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal text-muted-foreground">Signed in with the sender API key</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => signOut()}>
                  <KeyRound /> Change API key
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Suspense
          fallback={
            <div className="flex justify-center py-24 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" aria-label="Loading" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
