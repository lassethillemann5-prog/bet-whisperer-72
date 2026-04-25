import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import appCss from "../styles.css?url";
import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-pitch px-4">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-primary">404 · offside</p>
        <h1 className="mt-4 font-display text-7xl font-bold text-foreground">Out of play</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          That page doesn't exist. Let's get you back on the pitch.
        </p>
        <div className="mt-8">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary-glow glow-primary"
          >
            Back to fixtures
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Pitchcast — Football match predictions & tracker" },
      {
        name: "description",
        content:
          "Track football fixtures and get statistical + AI predictions for 1X2, Over/Under 1.5 & 2.5 goals, corners, shots and shots on target.",
      },
      { property: "og:title", content: "Pitchcast — Football match predictions & tracker" },
      {
        property: "og:description",
        content:
          "Statistical + AI predictions across 1X2, O/U goals, corners and shots markets.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Pitchcast — Football match predictions & tracker" },
      { name: "description", content: "Football prediction app for game outcomes, goals, and shots." },
      { property: "og:description", content: "Football prediction app for game outcomes, goals, and shots." },
      { name: "twitter:description", content: "Football prediction app for game outcomes, goals, and shots." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/dec91eda-5daa-47ce-b095-43223927b8e8/id-preview-801a0a6c--e02f00b5-c664-4815-8d21-933fa2ac8f3d.lovable.app-1777077931498.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/dec91eda-5daa-47ce-b095-43223927b8e8/id-preview-801a0a6c--e02f00b5-c664-4815-8d21-933fa2ac8f3d.lovable.app-1777077931498.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;600&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <AuthProvider>
      <Outlet />
      <Toaster />
    </AuthProvider>
  );
}
