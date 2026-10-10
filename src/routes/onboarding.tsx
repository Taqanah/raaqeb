import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { readOnboarding } from "./-onboarding.ts";

// The onboarding layout: the three screens live under it and read
// the step from its context. Once the operator account exists the routes
// answer 404; the not-found boundary is the root's.
export const Route = createFileRoute("/onboarding")({
  beforeLoad: async () => {
    const { step, steps } = await readOnboarding();
    if (step === "done") {
      throw notFound();
    }
    return { step, steps };
  },
  component: Outlet,
});
