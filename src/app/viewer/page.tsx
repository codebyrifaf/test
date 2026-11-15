import type { Metadata } from "next";
import { PageHeading } from "@/components/page-heading";
import { ViewerWorkspace } from "@/components/viewer-workspace";
export const metadata: Metadata = { title: "Answer viewer" };
export default function ViewerPage() {
  return (
    <>
      <PageHeading
        eyebrow="Person B · Answer viewer"
        title="Room for the answer."
        description="A private, single-line display for incoming answers."
      />
      <ViewerWorkspace />
    </>
  );
}
