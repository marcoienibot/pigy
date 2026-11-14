import { createRootRoute } from "@tanstack/react-router";

// The screens are in two groups. Those under `_app` need a session and
// share the app shell. The others, such as the sign-in page, are public.
export const Route = createRootRoute();
