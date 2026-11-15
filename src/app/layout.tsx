import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { APP_NAME } from "@/lib/constants";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: `${APP_NAME} — Your answer workspace`,
    template: `%s | ${APP_NAME}`,
  },
  description:
    "A private question sender and live answer viewer, with AI answers drawn only from your memory.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    // Some browsers add their own attributes to <html> before the app loads
    // (Chrome on iPhone adds __gcrremoteframetoken). Ignore only that tag's
    // attribute differences; mismatches inside the page are still reported.
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
