/**
 * The `raaqeb` command line: one optional subcommand, `serve` by
 * default, flags that mirror the boot setting variables, reset-password's
 * `--interactive` and set-address's one argument, and the `--version` and
 * `--help` answers, nothing more.
 */
import { isOrigin } from "@/shared/schemas/address.ts";
import type { BootValues, BootVariable } from "./settings.ts";

export const commands = [
  "serve",
  "health",
  "reset-password",
  "set-address",
] as const;
/** The four commands, and the two answers a flag gives in place of running one. */
export type Command = (typeof commands)[number] | "help" | "version";

export type CommandLine =
  | {
      ok: true;
      /** The public address set-address stores, an origin; nothing for every other command. */
      address?: string;
      command: Command;
      flags: BootValues;
      /** `--interactive`, which only reset-password takes. */
      interactive: boolean;
    }
  | { ok: false; message: string };

const flagVariables: Readonly<Record<string, BootVariable>> = {
  "--better-auth-secrets": "BETTER_AUTH_SECRETS",
  "--data-dir": "RAAQEB_DATA_DIR",
  "--database-url": "DATABASE_URL",
  "--host": "RAAQEB_HOST",
  "--port": "RAAQEB_PORT",
  "--secret-key": "RAAQEB_SECRET_KEY",
  "--trusted-proxies": "RAAQEB_TRUSTED_PROXIES",
};

/** What `raaqeb --help` prints: the version, then each command and the two flags with one line each. */
export function helpText(version: string): string {
  return `raaqeb ${version}

usage: raaqeb [command] [flags]

commands:
  serve                 run the server; the default
  health                exit 0 when the server answers at its address
  reset-password        print a reset link for the operator account
  set-address <url>     store the public address, as https://status.example.com

flags:
  --version             print the version
  --help                print this text

The boot settings also take flags, each the lowercase name of its RAAQEB_ variable (--port, --data-dir).`;
}

function isCommand(word: string): word is (typeof commands)[number] {
  return (commands as readonly string[]).includes(word);
}

/** The flag that answers before the line is read any further. */
const answers: Readonly<Record<string, Command>> = {
  "--help": "help",
  "--version": "version",
};

function refuse(message: string): CommandLine {
  return { message, ok: false };
}

/**
 * Parses the arguments after the program name. Accepts `--flag value` and
 * `--flag=value`. The message of a failed parse names the flag, never a value.
 */
export function parseCommandLine(args: readonly string[]): CommandLine {
  const answer = args.find((arg) => arg in answers);
  if (answer !== undefined) {
    return {
      command: answers[answer] ?? "help",
      flags: {},
      interactive: false,
      ok: true,
    };
  }
  // The one flag that is not a boot setting; its place on the line does not matter.
  const interactive = args.includes("--interactive");
  const line = parseWords(args.filter((arg) => arg !== "--interactive"));
  if (!line.ok) {
    return line;
  }
  if (interactive && line.command !== "reset-password") {
    return refuse("--interactive is only for reset-password");
  }
  if (line.command === "set-address") {
    // Refused here, before the data directory or the database is touched.
    if (line.address === undefined) {
      return refuse(
        "set-address needs the public address, as in: raaqeb set-address https://status.raaqeb.dev"
      );
    }
    if (!isOrigin(line.address)) {
      return refuse(
        "set-address takes an origin: the scheme and host only, with no path and no trailing slash, as https://status.raaqeb.dev"
      );
    }
  }
  return { ...line, interactive };
}

/** The command and the boot setting flags. */
function parseWords(args: readonly string[]): CommandLine {
  const words: string[] = [];
  const flags: BootValues = {};
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    index += 1;
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const variable = flagVariables[name];
    if (!variable) {
      return refuse(`unknown flag: ${name}`);
    }
    if (equals !== -1) {
      flags[variable] = arg.slice(equals + 1);
      continue;
    }
    const next = args[index];
    if (next === undefined || next.startsWith("--")) {
      return refuse(`${name} needs a value`);
    }
    flags[variable] = next;
    index += 1;
  }
  return commandOf(words, flags);
}

/** The command among the words that are not flags, and the one argument set-address takes. */
function commandOf(words: readonly string[], flags: BootValues): CommandLine {
  const [command = "serve", ...rest] = words;
  if (!isCommand(command)) {
    return refuse(`unknown command: ${command}`);
  }
  const [address, extra] =
    command === "set-address" ? rest : [undefined, ...rest];
  if (extra !== undefined) {
    return refuse(`unexpected argument after ${command}: ${extra}`);
  }
  return {
    ...(address !== undefined && { address }),
    command,
    flags,
    interactive: false,
    ok: true,
  };
}
