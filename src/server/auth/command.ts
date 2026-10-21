/**
 * `raaqeb reset-password [email]`: mints Better Auth's core reset
 * token for the operator account the email names, or the one account of an
 * install that has one, and prints its link, so the password never
 * touches the shell; with `--interactive` it asks for the new password with
 * hidden input and resets it through the same endpoint, so sessions and
 * trusted browsers are revoked the same way. Either way it switches that
 * account's second step off and removes its authenticator app, for the
 * operator who also lost the phone or email: shell access proves ownership.
 * Runs beside a live server over the same database. Exit codes follow
 * `health`: 0 done, 1 no such account, no public address or a database that
 * did not answer, 2 a command line the terminal cannot serve or that names
 * no account where several exist.
 */
// biome-ignore lint/style/noRestrictedImports: Bun has no prompt with hidden input; readline over a muted output is the platform's way.
import { createInterface } from "node:readline";
// biome-ignore lint/style/noRestrictedImports: readline needs a Writable to mute, and Bun has no other.
import { Writable } from "node:stream";
import { readPublicAddress } from "@/server/settings/address.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { passwordMaxLength, passwordMinLength } from "@/shared/schemas/auth.ts";
import { type AuthBoot, type AuthMail, buildAuth } from "./auth.ts";

/** The terminal the command talks to; a test hands a scripted one. */
export interface Terminal {
  /** Reads one answer without echo; an empty or closed stdin answers "". */
  readonly askHidden: (question: string) => Promise<string>;
  readonly err: (line: string) => void;
  /** Whether stdin is a terminal, which hidden input needs. */
  readonly interactive: boolean;
  readonly out: (line: string) => void;
}

export interface ResetPasswordOptions {
  /** The account's email; it may be left out while the install has one account. */
  readonly email?: string;
  readonly interactive: boolean;
}

/** Why `--interactive` is refused without a terminal. */
export const needsTerminal =
  "--interactive needs a terminal for hidden input; run without it to print a link instead";

/** Runs the command over an open storage and answers the exit code. */
export async function resetPasswordCommand(
  storage: Storage,
  boot: AuthBoot,
  options: ResetPasswordOptions,
  terminal: Terminal
): Promise<number> {
  if (options.interactive && !terminal.interactive) {
    terminal.err(needsTerminal);
    return 2;
  }
  try {
    const accounts = await storage.operatorAccounts.list();
    if (accounts.length === 0) {
      terminal.err("there is no operator account yet; finish onboarding first");
      return 1;
    }
    const named = options.email?.toLowerCase();
    if (named === undefined && accounts.length > 1) {
      terminal.err(
        `this install has ${accounts.length} operator accounts; name the one to reset, as in: raaqeb reset-password ${accounts[0]?.email}`
      );
      for (const one of accounts) {
        terminal.err(`  ${one.email} (${one.role})`);
      }
      return 2;
    }
    const account =
      named === undefined
        ? accounts[0]
        : accounts.find((one) => one.email.toLowerCase() === named);
    if (!account) {
      terminal.err(
        `there is no operator account with the email ${options.email}`
      );
      return 1;
    }
    if (!(await readPublicAddress(storage))) {
      terminal.err(
        "no public address is stored, so there is no link to print; set it on the general settings page"
      );
      return 1;
    }
    const newPassword = options.interactive
      ? await askPassword(terminal)
      : undefined;
    if (newPassword === null) {
      return 1;
    }
    let link: string | undefined;
    const printing: AuthMail = {
      code: () => Promise.resolve(),
      resetLink: (_to, minted) => {
        link = minted;
        return Promise.resolve();
      },
    };
    const auth = await buildAuth(storage, boot, printing);
    await auth.api.requestPasswordReset({ body: { email: account.email } });
    if (!link) {
      terminal.err("Better Auth minted no reset link");
      return 1;
    }
    if (newPassword === undefined) {
      terminal.out("Open this link within one hour to set a new password:");
      terminal.out(link);
    } else {
      const token = new URL(link).searchParams.get("token") ?? "";
      await auth.api.resetPassword({ body: { newPassword, token } });
      terminal.out(
        "The password was changed and every session has ended. Sign in with the new password."
      );
    }
    // Shell access proves ownership, so the second step goes off with its authenticator app; an app never confirmed goes too.
    await storage.operatorAccounts.secondStepOff(account.id);
    if (account.secondStep) {
      terminal.out(
        "The second step is off, and the authenticator app and its backup codes are removed. Turn it on again on the sign-in settings page."
      );
    }
    return 0;
  } catch {
    // It may have stopped after a write (a minted link, a new password), so it says only that it stopped.
    terminal.err(
      "the database did not answer and the command stopped; run it again"
    );
    return 1;
  }
}

/** The new password typed twice without echo; null when the two differ or the length is outside the rule. */
async function askPassword(terminal: Terminal): Promise<string | null> {
  const first = await terminal.askHidden("New password: ");
  const second = await terminal.askHidden("The same password again: ");
  if (first !== second) {
    terminal.err("the two passwords differ; nothing was changed");
    return null;
  }
  if (first.length < passwordMinLength || first.length > passwordMaxLength) {
    terminal.err(
      `a password needs ${passwordMinLength} to ${passwordMaxLength} characters; nothing was changed`
    );
    return null;
  }
  return first;
}

/** The process's own terminal: stdout and stderr, and readline over stdin with a muted output for hidden input. */
export function processTerminal(): Terminal {
  const askHidden = (prompt: string): Promise<string> => {
    let muted = false;
    const output = new Writable({
      write: (chunk, _encoding, done) => {
        if (!muted) {
          process.stdout.write(chunk);
        }
        done();
      },
    });
    const reader = createInterface({
      input: process.stdin,
      output,
      terminal: process.stdin.isTTY === true,
    });
    return new Promise((resolve) => {
      reader.on("close", () => resolve(""));
      reader.question(prompt, (answer) => {
        process.stdout.write("\n");
        // Before close: its handler answers "" for a closed stdin, and the first answer wins.
        resolve(answer);
        reader.close();
      });
      // The prompt is written; everything typed after it is not echoed.
      muted = true;
    });
  };
  return {
    askHidden,
    err: (line) => process.stderr.write(`raaqeb: ${line}\n`),
    interactive: process.stdin.isTTY === true,
    out: (line) => process.stdout.write(`${line}\n`),
  };
}
