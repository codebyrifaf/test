import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon";
import { Navigation } from "@/components/navigation";
import { APP_NAME } from "@/lib/constants";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link
          href="/"
          aria-label={`${APP_NAME} home`}
          className="mx-6 my-7 flex w-fit items-center gap-3 lg:my-9"
        >
          <span className="flex size-9 items-center justify-center rounded-xl bg-violet-300 text-slate-950">
            <Icon name="link" className="size-5" />
          </span>
          <span className="text-[23px] font-semibold tracking-tight">
            {APP_NAME}
            <span className="text-violet-300">.</span>
          </span>
        </Link>
        <p className="mb-3 hidden px-7 text-[10px] font-semibold tracking-[0.18em] text-muted lg:block">
          WORKSPACE
        </p>
        <Navigation />
        <div className="mx-4 mt-auto mb-5 hidden rounded-xl border border-line bg-white/[0.02] p-4 lg:block">
          <div className="flex items-center gap-2 text-xs font-medium">
            <span
              className="size-1.5 rounded-full bg-amber-300"
              aria-hidden="true"
            />
            Private live workspace
          </div>
          <p className="mt-2 text-xs leading-5 text-muted">
            One sender. One viewer. The latest answer, delivered privately.
          </p>
          <div className="mt-4 flex items-center justify-between border-t border-line pt-3 font-mono text-[10px] text-muted">
            <span>RELAY</span>
            <span>LIVE SESSIONS</span>
          </div>
        </div>
      </aside>
      <div className="min-w-0 lg:ml-60">
        <header className="flex min-h-20 flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-8 lg:px-10">
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="text-foreground">{APP_NAME}</span>
            <span aria-hidden="true" className="text-slate-600">
              /
            </span>
            <span>Question-to-answer workspace</span>
          </div>
          <span className="status-badge">One session at a time</span>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto min-w-0 max-w-[1280px] px-5 py-8 outline-none sm:px-8 lg:px-10 lg:py-10"
        >
          {children}
        </main>
        <footer className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-2 px-5 pt-2 pb-7 text-[11px] text-muted sm:px-8 lg:px-10">
          <span>{APP_NAME} · A clearer way to connect.</span>
          <span>Private answers · Shared focus</span>
        </footer>
      </div>
    </>
  );
}
