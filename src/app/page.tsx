import { HomeWorkspace } from "@/components/home-workspace";
import { PageHeading } from "@/components/page-heading";
export default function HomePage() {
  return (
    <>
      <PageHeading
        eyebrow="Your workspace"
        title="Good questions. Clear answers."
        description="Two dedicated spaces, one private session. Send questions from one browser and view answers in another."
      />
      <HomeWorkspace />
    </>
  );
}
