import type { NavigationItem } from "@/types/ui";

export const APP_NAME = "Relay";

export const NAVIGATION_ITEMS = [
  { href: "/", label: "Overview", icon: "home" },
  { href: "/sender", label: "Question sender", icon: "send", role: "sender" },
  { href: "/viewer", label: "Answer viewer", icon: "display", role: "viewer" },
  { href: "/admin", label: "Administration", icon: "shield" },
] as const satisfies readonly NavigationItem[];

/** Static design sample. This is never supplied to the sender or an API. */
export const VIEWER_SAMPLE_TEXT =
  "Every good answer begins with a thoughtful question.";

/** UI-only values; no animation or persisted settings are implemented in Step 1. */
export const SPEED_PREVIEW = {
  min: 40,
  max: 240,
  step: 10,
  initial: 120,
} as const;

/**
 * Marker before text that used internet sources (Wikipedia/GOV.UK): at the
 * start of a whole web answer, or after the memory part of an answer. The
 * viewer removes it, shows a badge and colours that text amber.
 */
export const WEB_ANSWER_PREFIX = "[web] ";
/**
 * Marker before a made-up, general answer to a soft question about the
 * applicant that the memory does not answer (for example how they use advice
 * from teachers). The viewer removes it, shows a badge and colours it blue.
 */
export const MADE_UP_ANSWER_PREFIX = "[made-up] ";
/**
 * Marker before an honest reply to a question that needs a specific fact the
 * memory does not have (for example relatives in the UK or a test score): it
 * never invents the fact. The viewer removes it, shows a badge asking the
 * reader to say the real fact, and colours it red.
 */
export const HONEST_ANSWER_PREFIX = "[check] ";
