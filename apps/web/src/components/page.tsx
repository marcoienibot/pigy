import { type ReactNode, useEffect } from "react";
import { UserMenu } from "@/components/user-menu";

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · pigy`;
  }, [title]);
}

/** Header and scrollable body shared by every screen of the app. */
export function Page({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  useTitle(title);

  return (
    <>
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-4">
        <h1 className="font-medium">{title}</h1>
        {/* On desktop the menu is in the sidebar. */}
        <div className="md:hidden">
          <UserMenu placement="header" />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-4">{children}</main>
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
