import {
  HONEST_ANSWER_PREFIX,
  MADE_UP_ANSWER_PREFIX,
  WEB_ANSWER_PREFIX,
} from "@/lib/constants";

/** Where the text of a marked answer part came from. */
export type MarkedSource = "web" | "made-up" | "honest";

const MARKERS: [MarkedSource, string][] = [
  ["web", WEB_ANSWER_PREFIX],
  ["made-up", MADE_UP_ANSWER_PREFIX],
  ["honest", HONEST_ANSWER_PREFIX],
];

/**
 * Reads an answer as published: the text to show (without the marker) and,
 * when part of it is not from the memory, where that part starts (0 = the
 * whole answer). An answer has at most one marker.
 */
export function readAnswerMarker(answer: string): {
  text: string;
  marked?: { source: MarkedSource; from: number };
} {
  for (const [source, marker] of MARKERS) {
    const from = answer.indexOf(marker);
    if (from >= 0)
      return {
        text: answer.slice(0, from) + answer.slice(from + marker.length),
        marked: { source, from },
      };
  }
  return { text: answer };
}
