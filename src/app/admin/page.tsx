import type { Metadata } from "next";
import { PageHeading } from "@/components/page-heading";
import { AdminWorkspace } from "@/components/admin-workspace";
export const metadata: Metadata = { title: "Administration" };
export default function AdminPage() {
  return (
    <>
      <PageHeading
        eyebrow="Administration"
        title="The knowledge behind the answers."
        description="Set the memory that every answer comes from."
      />
      <AdminWorkspace />
    </>
  );
}
