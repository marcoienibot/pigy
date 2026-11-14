import { type ReactNode, useEffect } from "react";

/** Header and scrollable body shared by every screen. */
export function Page({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · pigy`;
  }, [title]);

  return (
    <>
      <header className="flex h-11 shrink-0 items-center border-b px-4">
        <h1 className="font-medium">{title}</h1>
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
