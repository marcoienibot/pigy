import { type ReactNode, useEffect } from "react";
import { SyncIndicator } from "@/components/sync-indicator";
import { UserMenu } from "@/components/user-menu";
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
 */
export function Page({
  title,
  actions,
  fill = false,
  children,
}: {
  title: string;
  actions?: ReactNode;
  fill?: boolean;
  children: ReactNode;
}) {
  useTitle(title);

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="font-medium">{title}</h1>
        <div className="ml-auto flex items-center gap-1">
          {actions}
          {/* On desktop these are in the sidebar. */}
          <div className="flex items-center md:hidden">
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
