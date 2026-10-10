/**
 * The onboarding guard the routes share: one server function
 * answering the step the install is at, and the redirect every page outside
 * onboarding throws while an operator account does not exist. Not a route
 * file: the leading dash keeps it out of the route tree.
 */
import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  type OnboardingStep,
  onboardingStep,
  onboardingSteps,
} from "@/server/onboarding/onboarding.ts";

export const readOnboardingStep = createServerFn({ method: "GET" }).handler(
  ({ context }): Promise<OnboardingStep> => onboardingStep(context.storage)
);

/** The step, and how many screens this install's onboarding has, for the step counter. */
export const readOnboarding = createServerFn({ method: "GET" }).handler(
  async ({ context }): Promise<{ step: OnboardingStep; steps: 2 | 3 }> => ({
    step: await onboardingStep(context.storage),
    steps: onboardingSteps(context.boot),
  })
);

/** Sends a request to onboarding while no operator account exists; answers the step otherwise. */
export async function requireOnboardingDone(): Promise<void> {
  if ((await readOnboardingStep()) !== "done") {
    throw redirect({ to: "/onboarding" });
  }
}
