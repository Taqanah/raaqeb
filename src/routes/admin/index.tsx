import { createFileRoute, redirect } from "@tanstack/react-router";

// The admin area's front is the monitors list.
export const Route = createFileRoute("/admin/")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/monitors" });
  },
});
