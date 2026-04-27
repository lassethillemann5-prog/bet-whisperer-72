import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { LogOut, Activity, Star, LayoutGrid, Wallet, Layers, Hammer, BarChart3 } from "lucide-react";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, signOut, loading } = useAuth();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });

  const navItem = (to: string, label: string, Icon: typeof Activity) => {
    const active = path === to || (to !== "/" && path.startsWith(to));
    return (
      <Link
        to={to}
        className={`group inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
          active
            ? "bg-primary/15 text-primary"
            : "text-muted-foreground hover:bg-secondary hover:text-foreground"
        }`}
      >
        <Icon className="h-4 w-4" />
        {label}
      </Link>
    );
  };

  return (
    <div className="min-h-screen bg-pitch text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 md:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-primary glow-primary">
              <Activity className="h-5 w-5 text-primary-foreground" strokeWidth={2.5} />
            </div>
            <div className="leading-tight">
              <div className="font-display text-lg font-bold tracking-tight">Pitchcast</div>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                stats · ai · markets
              </div>
            </div>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {navItem("/", "Fixtures", LayoutGrid)}
            {navItem("/stats", "Stats", BarChart3)}
            {navItem("/tracked", "Tracked", Star)}
            {navItem("/accumulator", "Accumulator", Layers)}
            {navItem("/builder", "Bet Builder", Hammer)}
            {navItem("/bankroll", "Bankroll", Wallet)}
          </nav>

          <div className="flex items-center gap-2">
            {!loading && user ? (
              <>
                <span className="hidden text-xs text-muted-foreground md:inline">
                  {user.email}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    await signOut();
                    navigate({ to: "/login" });
                  }}
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </>
            ) : !loading ? (
              <Button size="sm" onClick={() => navigate({ to: "/login" })}>
                Sign in
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex gap-1 border-t border-border/60 px-3 py-2 md:hidden">
          {navItem("/", "Fixtures", LayoutGrid)}
          {navItem("/stats", "Stats", BarChart3)}
          {navItem("/tracked", "Tracked", Star)}
          {navItem("/accumulator", "Accumulator", Layers)}
          {navItem("/builder", "Bet Builder", Hammer)}
          {navItem("/bankroll", "Bankroll", Wallet)}
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-10">{children}</main>

      <footer className="border-t border-border/60 py-6 text-center text-xs text-muted-foreground">
        Data via{" "}
        <a
          href="https://www.football-data.org/"
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          football-data.org
        </a>
        {" · "}AI by Lovable
      </footer>
    </div>
  );
}
