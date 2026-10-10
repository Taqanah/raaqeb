/**
 * The capability registry (ADR-0001). An optional capability is off by
 * default and core code reaches it only through this registry's dynamic
 * import(), so a capability nobody enabled costs nothing: its module is never
 * loaded. Check types and channels are compiled in, nothing is loaded from
 * outside the repository (CONTEXT.md, "Optional capability").
 */

/** What a capability module exposes once loaded. Grows when the first capability lands. */
export interface Capability<Name extends string = string> {
  readonly name: Name;
}

/**
 * Imports one capability's module. A real loader reads
 * `() => import("./<name>/capability.ts").then((m) => m.capability)`, which
 * keeps the module out of the process until the first load.
 */
export type CapabilityLoader<Name extends string> = () => Promise<
  Capability<Name>
>;

export interface CapabilityRegistry<Name extends string> {
  readonly has: (name: string) => name is Name;
  /** Imports the module on the first call and answers with the same instance after. */
  readonly load: (name: Name) => Promise<Capability<Name>>;
  /** Every capability compiled in, enabled or not. */
  readonly names: readonly Name[];
}

export function createRegistry<Name extends string>(
  loaders: {
    readonly [N in Name]: CapabilityLoader<N>;
  }
): CapabilityRegistry<Name> {
  const has = (name: string): name is Name => Object.hasOwn(loaders, name);
  const names = Object.keys(loaders).filter(has);
  const loading = new Map<Name, Promise<Capability<Name>>>();
  const load = (name: Name) => {
    const pending = loading.get(name);
    if (pending !== undefined) {
      return pending;
    }
    const started = loaders[name]();
    loading.set(name, started);
    // A failed import is forgotten so the next load tries again.
    started.catch(() => loading.delete(name));
    return started;
  };
  return { has, load, names };
}

/** v1 ships no optional capability. The union grows with the first one. */
export type CapabilityName = never;

export const capabilities: CapabilityRegistry<CapabilityName> =
  createRegistry<CapabilityName>({});
