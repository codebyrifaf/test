"use client";
import { useEffect, useRef } from "react";
import type { MarkedSource } from "@/lib/answer-marker";

/** Amber from the internet, blue made up, red an honest reply (fact missing). */
const MARK_COLOURS: Record<MarkedSource, string> = {
  web: "text-amber-200",
  "made-up": "text-sky-300",
  honest: "text-rose-300",
};

export function AnswerTicker({
  text,
  playbackKey,
  speed,
  final,
  marked,
  onComplete,
}: {
  text: string;
  playbackKey: number;
  speed: number;
  /** False while the answer is still arriving; the pass cannot finish yet. */
  final: boolean;
  /** Where text not from the memory starts (0 = all of it); see MARK_COLOURS. */
  marked?: { source: MarkedSource; from: number };
  onComplete: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const currentSpeed = useRef(speed);
  const isFinal = useRef(final);
  const completed = useRef(onComplete);
  useEffect(() => {
    currentSpeed.current = speed;
  }, [speed]);
  useEffect(() => {
    isFinal.current = final;
  }, [final]);
  useEffect(() => {
    completed.current = onComplete;
  }, [onComplete]);
  // Restarts only for a new answer; growing text keeps the current position.
  useEffect(() => {
    const viewport = container.current;
    const content = line.current;
    if (!viewport || !content) return;
    let x = viewport.clientWidth;
    let width = content.scrollWidth;
    let previous: number | null = null;
    let frame = 0;
    let stopped = false;
    const measure = new ResizeObserver(() => {
      width = content.scrollWidth;
    });
    measure.observe(content);
    content.style.transform = `translate3d(${x}px,0,0)`;
    function tick(now: number) {
      if (stopped || !content || !viewport) return;
      if (previous !== null)
        x -= ((now - previous) / 1000) * currentSpeed.current;
      previous = now;
      // While text is still arriving, never scroll past the received end.
      if (!isFinal.current) x = Math.max(x, viewport.clientWidth - width);
      content.style.transform = `translate3d(${x}px,0,0)`;
      if (isFinal.current && x + width <= 0) {
        stopped = true;
        completed.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      measure.disconnect();
    };
  }, [playbackKey]);
  return (
    <div
      ref={container}
      className="w-full overflow-hidden py-8"
      data-testid="ticker-viewport"
    >
      <div
        ref={line}
        data-testid="answer-ticker"
        className="w-max whitespace-nowrap text-3xl leading-snug font-medium sm:text-[42px]"
        style={{ willChange: "transform" }}
      >
        {!marked ? (
          text
        ) : (
          <>
            {text.slice(0, marked.from)}
            <span
              className={MARK_COLOURS[marked.source]}
              data-testid={`${marked.source}-answer-text`}
            >
              {text.slice(marked.from)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
