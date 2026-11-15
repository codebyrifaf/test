"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icon";
import { NAVIGATION_ITEMS } from "@/lib/constants";

export function Navigation() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main navigation"
      className="grid grid-cols-2 gap-1 px-4 pb-4 sm:flex sm:flex-wrap lg:flex-col lg:px-4 lg:pb-0"
    >
      {NAVIGATION_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={pathname === item.href ? "page" : undefined}
          data-role={"role" in item ? item.role : undefined}
          className="nav-link"
        >
          <Icon name={item.icon} className="size-[18px] shrink-0" />
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
