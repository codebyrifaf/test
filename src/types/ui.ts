/** Presentational types only. Session and backend contracts belong to later steps. */
export type IconName =
  | "home"
  | "send"
  | "display"
  | "shield"
  | "arrow"
  | "plus"
  | "link"
  | "check"
  | "info"
  | "connection"
  | "sliders";

export type NavigationItem = Readonly<{
  href: "/" | "/sender" | "/viewer" | "/admin";
  label: string;
  icon: IconName;
  role?: "sender" | "viewer";
}>;
