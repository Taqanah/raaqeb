/** Resolves once the origin answers, or after the deadline; the second and third e2e servers wait for the first, which runs the build. */
export async function waitForOrigin(
  origin: string,
  deadline: number
): Promise<void> {
  if (Date.now() >= deadline) {
    return;
  }
  const up = await fetch(origin).then(
    (response) => response.ok || response.status === 404,
    () => false
  );
  if (!up) {
    await Bun.sleep(500);
    return waitForOrigin(origin, deadline);
  }
}
