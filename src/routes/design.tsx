import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { lazy, Suspense } from "react";
import { z } from "zod";
import { loadCatalog } from "@/server/settings/language.ts";
import { directionOf, localeSchema } from "@/shared/i18n/locale.ts";

// The sample page exists in development only: Vite replaces import.meta.env.DEV
// at build time, so the production document answers 404, the server function
// answers not-found, and the dynamic import below is dead code that the
// bundler drops, so the sample never enters the client assets the entry
// preloads. The locale comes from the search, because
// `vite dev` has no database to hold an install language; the sample mounts
// its own catalog under the document's.
const searchSchema = z.object({ locale: localeSchema.optional() });

const readSampleCatalog = createServerFn()
  .validator(localeSchema)
  .handler(async ({ data: locale }) => {
    if (!import.meta.env.DEV) {
      throw notFound();
    }
    return {
      catalog: JSON.stringify(await loadCatalog(locale)),
      dir: directionOf(locale),
      locale,
    };
  });

const DesignSample = import.meta.env.DEV
  ? lazy(() =>
      import("@/admin/design/sample.tsx").then((module) => ({
        default: module.DesignSample,
      }))
    )
  : () => null;

export const Route = createFileRoute("/design")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw notFound();
    }
  },
  component: DesignRoute,
  loaderDeps: ({ search }) => ({ locale: search.locale ?? "ar" }),
  loader: ({ deps }) => readSampleCatalog({ data: deps.locale }),
  validateSearch: (search: Record<string, unknown>) =>
    searchSchema.parse(search),
});

function DesignRoute() {
  const sample = Route.useLoaderData();
  return (
    <Suspense>
      <DesignSample {...sample} />
    </Suspense>
  );
}
