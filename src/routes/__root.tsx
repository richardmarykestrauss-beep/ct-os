import { Outlet, createRootRoute } from "@tanstack/react-router";
import { AppSidebar } from "@/components/os/AppSidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => (
    <div className="p-8 text-sm text-muted">
      Page not found. <a href="/" className="text-accent underline">Back to Overview</a>
    </div>
  ),
});

function RootLayout() {
  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col bg-canvas lg:flex-row">
        <AppSidebar />
        <main className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[1440px] px-4 py-5 md:px-6 md:py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
