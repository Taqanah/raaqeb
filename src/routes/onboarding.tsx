import {
  createFileRoute,
  notFound,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { readOnboarding } from "./-onboarding.ts";

// The onboarding layout: the three screens live under it and read
// the step from its context. Once the operator account exists the routes
// answer 404; the not-found boundary is the root's. In the browser, Back
// from the admin area onto a screen that is gone returns to the admin.
export const Route = createFileRoute("/onboarding")({
  beforeLoad: async () => {
    const { step, steps } = await readOnboarding();
    if (step === "done") {
      if (typeof window !== "undefined") {
        throw redirect({ replace: true, to: "/admin/monitors" });
      }
      throw notFound();
    }
    return { step, steps };
  },
  component: Outlet,
});
