import type { Metadata } from "next";
import { PageHeading } from "@/components/page-heading";
import { SenderWorkspace } from "@/components/sender-workspace";
export const metadata: Metadata = { title: "Question sender" };
export default function SenderPage() {
  return (
    <>
      <PageHeading
        eyebrow="Person A · Question sender"
        title="A space for your next question."
        description="Submit questions and follow their processing and delivery status. Answers are sent only to your viewer."
      />
      <SenderWorkspace />
    </>
  );
}
