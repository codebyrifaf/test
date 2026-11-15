import assert from "node:assert/strict";
import test from "node:test";
import { readAnswerMarker } from "../src/lib/answer-marker";

test("a plain memory answer has no marked part", () => {
  assert.deepEqual(readAnswerMarker("I studied BBA in Dhaka."), { text: "I studied BBA in Dhaka." });
});

test("a whole web or made-up answer is marked from the start, without the marker", () => {
  assert.deepEqual(readAnswerMarker("[web] Leicester has 383,116 people."), {
    text: "Leicester has 383,116 people.",
    marked: { source: "web", from: 0 },
  });
  assert.deepEqual(readAnswerMarker("[made-up] I plan my revision early."), {
    text: "I plan my revision early.",
    marked: { source: "made-up", from: 0 },
  });
});

test("a part added after a memory answer is marked from where it starts", () => {
  const memory = "I'll pay it when I apply. ";
  const { text, marked } = readAnswerMarker(`${memory}[web] It's £776 per year.`);
  assert.equal(text, "I'll pay it when I apply. It's £776 per year.");
  assert.deepEqual(marked, { source: "web", from: memory.length });
  assert.equal(text.slice(marked!.from), "It's £776 per year.");
  const soft = readAnswerMarker("I learned time management. [made-up] I ask for feedback early.");
  assert.equal(soft.text, "I learned time management. I ask for feedback early.");
  assert.equal(soft.text.slice(soft.marked!.from), "I ask for feedback early.");
});
