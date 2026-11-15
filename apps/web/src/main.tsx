import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { startServiceWorker } from "@/lib/service-worker";
import { onSessionChange } from "@/lib/session";
import { routeTree } from "./routeTree.gen";
import "./styles.css";
// Listens for the browser's offer to install pigy, which comes once.
import "@/lib/install";

const router = createRouter({
  routeTree,
  // Load a route's code and data when a link is hovered or focused.
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// The screens were given a name or a role that the server has since
// changed: they are given the new one.
onSessionChange(() => void router.invalidate());

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// Before anything is on screen: if a newer version of the app is installed
// and waiting, this page gives way to it here, and nothing below runs.
await startServiceWorker().catch((error: unknown) =>
  console.error("Service worker", error),
);

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  </StrictMode>,
);
