import type { IconName } from "@/types/ui";

const paths: Record<IconName, string> = {
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z",
  send: "m21 3-7 18-4-7-7-4 18-7ZM21 3 10 14",
  display:
    "M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM8 21h8m-4-4v4",
  shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  plus: "M12 5v14M5 12h14",
  link: "m10 13 4-4m-7 5-2 2a3.5 3.5 0 0 0 5 5l4-4a3.5 3.5 0 0 0 0-5M10 12a3.5 3.5 0 0 1 0-5l4-4a3.5 3.5 0 0 1 5 5l-2 2",
  check: "m5 12 4 4L19 6",
  info: "M12 8h.01M12 11v5M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  connection: "M5 12h2m3 0h4m3 0h2M2 9v6m20-6v6M5 5l14 14",
  sliders: "M4 7h6m4 0h6M4 17h10m4 0h2M10 4v6m4 4v6",
};

export function Icon({
  name,
  className = "size-4",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={paths[name]} />
    </svg>
  );
}
