import { useRouteContext } from "@tanstack/react-router";
import { type ReactNode, type Ref, useEffect } from "react";
import { SyncIndicator } from "@/components/sync-indicator";
import { UserMenu } from "@/components/user-menu";
import { WorkspaceSwitch } from "@/components/workspace-switch";
import { cn } from "@/lib/utils";

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · pigy`;
  }, [title]);
}

/**
 * Header and body shared by every screen of the app. `actions` go to the
 * right of the title. The body scrolls and has a margin, unless the screen
 * asks to `fill` it and lays it out itself.
 *
 * A screen that asks for the `heading` can send the keyboard to it: the
 * title can take the focus then, from code and not with Tab. That is where
 * the focus goes when what had it is gone and nothing else can take it.
 */
export function Page({
  title,
  heading,
  actions,
  fill = false,
  children,
}: {
  title: string;
  heading?: Ref<HTMLHeadingElement>;
  actions?: ReactNode;
  fill?: boolean;
  children: ReactNode;
}) {
  const { workspace } = useRouteContext({ from: "/_app" });
  // The name of a tab says so too: two tabs can show the two workspaces.
  useTitle(workspace.environment === "sandbox" ? `${title} · Sandbox` : title);

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <h1
          ref={heading}
          tabIndex={heading ? -1 : undefined}
          className="rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {title}
        </h1>
        <div className="ml-auto flex items-center gap-1">
          {actions}
          {/* On desktop these are in the sidebar. */}
          <div className="flex items-center gap-1 pl-1 md:hidden">
            <WorkspaceSwitch placement="header" />
            <SyncIndicator placement="header" />
            <UserMenu placement="header" />
          </div>
        </div>
      </header>
      <main
        className={cn("min-h-0 flex-1", fill ? "flex" : "overflow-y-auto p-4")}
      >
        {children}
      </main>
    </>
  );
}

/** Centred message for a screen that has nothing to show. */
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-sm py-16 text-center">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-1 text-muted-foreground">{description}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

/**
 * A screen for people who are not signed in, without the app's navigation:
 * the logo, a heading and whatever the screen is for.
 */
export function PublicPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  useTitle(title);

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-xs text-center">
        <img src="/icon.svg" alt="" className="mx-auto size-10 rounded-lg" />
        <h1 className="mt-4 text-lg font-semibold tracking-tight">{title}</h1>
        {children}
      </div>
    </main>
  );
}
