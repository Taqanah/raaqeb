/**
 * The setup checks (CONTEXT.md "Setup check"): what each one found, in
 * the order the page lists them. A check that could not know is absent, so
 * the list holds only what was checked; a passing one is listed as passing.
 */

/** Where the trusted proxies in force come from: the general page, `RAAQEB_TRUSTED_PROXIES`, or `--trusted-proxies`, which wins over the variable. */
export type ProxiesSource = "setting" | "variable" | "flag";

export type SetupCheck =
  /** The request's forwarded headers against the peer that sent them. */
  | {
      readonly check: "forwarded";
      /** The `X-Forwarded-*` headers the request carries, by name. */
      readonly headers: readonly string[];
      readonly passed: boolean;
      /** The socket peer: the proxy's address when there is one. */
      readonly peer: string;
      /** Where the fix goes. */
      readonly proxiesFrom: ProxiesSource;
      /** The peer is a trusted proxy, whether or not it forwarded anything. */
      readonly trusted: boolean;
    }
  /** The stored public address against the origin the browser is at. */
  | {
      readonly browser: string;
      readonly check: "public_address";
      readonly passed: boolean;
      /** Nothing when no valid public address is stored. */
      readonly stored: string | undefined;
    }
  /** Whether an email channel exists to send reset links and second step codes. */
  | { readonly check: "email_channel"; readonly passed: boolean }
  /** The data directory's mode, judged by whether anything secret is in it. */
  | {
      readonly check: "data_directory_mode";
      /** The permission bits, 0o700 for owner only. */
      readonly mode: number;
      /** The directory is on the server's own root filesystem, or its mount is unknown: chmod on the server reaches it, where a volume's mode is set where the volume is made. */
      readonly onHostRoot: boolean;
      readonly passed: boolean;
      readonly path: string;
      /** The files in it that hold secrets: `config.json`, the SQLite file. */
      readonly secrets: readonly string[];
    }
  /** What the data directory is mounted on, where that tells whether a new container keeps it. */
  | {
      readonly check: "data_directory_volume";
      /** The container's overlay root, a volume Docker made without a name for the image's `VOLUME`, memory (tmpfs or ramfs), or a mount of its own. */
      readonly mount: "container_root" | "anonymous_volume" | "memory" | "own";
      readonly passed: boolean;
      readonly path: string;
    };
