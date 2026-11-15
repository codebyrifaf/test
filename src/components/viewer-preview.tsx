"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { SPEED_PREVIEW, VIEWER_SAMPLE_TEXT } from "@/lib/constants";

export function ViewerPreview() {
  const [speed, setSpeed] = useState<number>(SPEED_PREVIEW.initial);

  return (
    <>
      <section
        aria-labelledby="display-heading"
        className="overflow-hidden rounded-2xl border border-line bg-[#06090e]"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
          <h2
            id="display-heading"
            className="flex items-center gap-2 text-xs font-medium"
          >
            <Icon name="display" className="size-4 text-teal-300" />
            Answer display
          </h2>
          <span className="text-[10px] font-medium tracking-widest text-muted uppercase">
            Static visual preview
          </span>
        </div>
        <div className="flex min-h-[320px] min-w-0 flex-col justify-center py-10 sm:min-h-[380px]">
          <div className="mb-7 flex justify-center">
            <span className="rounded-full border border-teal-300/20 bg-teal-300/5 px-3 py-1 text-[10px] font-medium tracking-widest text-teal-200 uppercase">
              Sample text · Not an API answer
            </span>
          </div>
          <div className="min-w-0 border-y border-white/[0.06] bg-white/[0.015] px-5 py-7 sm:px-8">
            <p
              data-testid="answer-preview"
              className="overflow-hidden text-3xl leading-snug font-medium tracking-tight text-ellipsis whitespace-nowrap text-slate-100 sm:text-[42px]"
            >
              {VIEWER_SAMPLE_TEXT}
            </p>
          </div>
          <p className="mt-7 px-5 text-center text-xs leading-6 text-muted">
            One line. A focused display.
            <br />
            Real-time scrolling will be implemented in Step 5.
          </p>
        </div>
        <div className="flex flex-wrap justify-between gap-2 border-t border-line px-5 py-3 font-mono text-[10px] text-muted sm:px-6">
          <span>DISPLAY PREVIEW</span>
          <span>NO LIVE ANSWER</span>
        </div>
      </section>
      <section aria-labelledby="speed-heading" className="panel mt-6">
        <div className="grid items-center gap-6 md:grid-cols-2">
          <div>
            <h2
              id="speed-heading"
              className="flex items-center gap-2 text-sm font-semibold"
            >
              <Icon name="sliders" className="size-4 text-teal-300" />
              Display speed
            </h2>
            <p id="speed-help" className="mt-2 text-xs leading-6 text-muted">
              Adjust the preview setting. This control changes the value only;
              the sample does not move and the setting is not saved.
            </p>
          </div>
          <div>
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="scroll-speed" className="text-xs font-medium">
                Scrolling speed
              </label>
              <output
                htmlFor="scroll-speed"
                className="rounded-md border border-teal-300/20 bg-teal-300/5 px-2.5 py-1 font-mono text-xs text-teal-200"
              >
                {speed} px/s
              </output>
            </div>
            <input
              id="scroll-speed"
              type="range"
              min={SPEED_PREVIEW.min}
              max={SPEED_PREVIEW.max}
              step={SPEED_PREVIEW.step}
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              aria-describedby="speed-help"
              aria-valuetext={`${speed} pixels per second, preview only`}
              className="mt-2 min-h-11 w-full"
            />
            <div
              aria-hidden="true"
              className="flex justify-between text-[10px] text-muted"
            >
              <span>Slower</span>
              <span>Faster</span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
