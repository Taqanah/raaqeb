/**
 * The auth settings screen's module: the email channel auth mail
 * goes through, the test message, the second step's switch, which turns on
 * with emailed codes only after a test message went through the chosen
 * channel, so nobody locks themselves out, and the authenticator app: its
 * setup, its first code, which turns the second step on, and a new set of
 * backup codes. Each card turns off its own method:
 * the second step's switch turns everything off, the app included; the
 * app's card removes the app alone and keeps emailed codes when they could
 * be turned on. Every change takes the current password. Every
 * function answers a result and never throws.
 */
import { isAPIError } from "better-auth/api";
import type { InstallKey } from "@/server/boot/installkey.ts";
import type { DeliverIo } from "@/server/notify/channel.ts";
import { readSetting } from "@/server/settings/clock.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  type AppConfirmInput,
  type AppConfirmResult,
  type AppPasswordInput,
  type AppSetupResult,
  type AuthTestResult,
  appConfirmSchema,
  appPasswordSchema,
  type BackupCodesResult,
  type SaveResult,
  type SecondStepInput,
  type SecondStepResult,
  type SecondStepView,
  secondStepSchema,
} from "@/shared/schemas/settings.ts";
import type { Auth } from "./auth.ts";
import {
  authEmailChannel,
  authEmailChannelOf,
  authEmailTested,
  sendAuthMail,
} from "./mail.ts";

export type SecondStepStorage = Pick<
  Storage,
  "channels" | "operatorAccount" | "settings"
>;

/** The screen's read; nothing before the operator account exists. */
export async function readSecondStep(
  storage: SecondStepStorage
): Promise<SecondStepView | undefined> {
  const account = await storage.operatorAccount.read();
  if (!account) {
    return;
  }
  const [channels, inForce, tested] = await Promise.all([
    storage.channels.list(),
    authEmailChannelOf(storage),
    readSetting(storage, authEmailTested, undefined),
  ]);
  return {
    channel: inForce?.id,
    channels: channels
      .filter((channel) => channel.type === "email")
      .map(({ id, name }) => ({ id, name })),
    email: account.email,
    on: account.secondStep,
    app: account.app,
    tested:
      inForce !== undefined &&
      inForce.id === tested?.channelId &&
      inForce.updatedAt === tested.updatedAt &&
      account.email === tested.email,
  };
}

/** Chooses the email channel auth mail goes through; refused when the id is not an email channel's. */
export async function chooseAuthEmailChannel(
  storage: SecondStepStorage,
  channelId: string
): Promise<SaveResult> {
  try {
    const channel = await storage.channels.find(channelId);
    if (channel?.type !== "email") {
      return { ok: false, reason: "invalid" };
    }
    await storage.settings.set(authEmailChannel, channel.id);
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Sends the test message to the operator account's address and remembers the channel it went through. */
export async function sendAuthTest(
  storage: SecondStepStorage,
  key: InstallKey,
  io: DeliverIo
): Promise<AuthTestResult> {
  try {
    const [account, channel] = await Promise.all([
      storage.operatorAccount.read(),
      authEmailChannelOf(storage),
    ]);
    if (!account) {
      return { ok: false, reason: "unavailable" };
    }
    if (!channel) {
      return { ok: false, reason: "no_channel" };
    }
    const sent = await sendAuthMail(storage, key, io, {
      kind: "test",
      to: account.email,
    });
    if (!sent.ok) {
      // The last test is the proof: a failed one undoes an earlier success.
      await storage.settings.remove(authEmailTested);
      return sent.reason === "failed"
        ? { failure: sent.failure, ok: false, reason: "failed" }
        : { ok: false, reason: "no_channel" };
    }
    await storage.settings.set(authEmailTested, {
      channelId: channel.id,
      email: account.email,
      updatedAt: channel.updatedAt,
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Turns the second step on or off after verifying the password; on is refused until a test message went through the channel in force. The session Better Auth re-issues comes back as cookies. */
export async function switchSecondStep(
  auth: Auth,
  headers: Headers,
  storage: SecondStepStorage,
  input: SecondStepInput
): Promise<SecondStepResult> {
  const parsed = secondStepSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { on, password } = parsed.data;
  try {
    if (on && !(await readSecondStep(storage))?.tested) {
      return { ok: false, reason: "not_tested" };
    }
    const switched = on
      ? await auth.api.enableTwoFactor({
          body: { method: "otp", password },
          headers,
          returnHeaders: true,
        })
      : await auth.api.disableTwoFactor({
          body: { password },
          headers,
          returnHeaders: true,
        });
    return { ok: true, setCookies: switched.headers.getSetCookie() };
  } catch (error) {
    return {
      ok: false,
      reason: wrongPassword(error) ? "wrong_password" : "unavailable",
    };
  }
}

/** Better Auth's refusal of the current password. */
function wrongPassword(error: unknown): boolean {
  return (
    isAPIError(error) &&
    (error.body?.code === "INVALID_PASSWORD" ||
      error.body?.code === "PASSWORD_TOO_LONG")
  );
}

/** Starts setting up the authenticator app after verifying the password: a new secret, not in force until its first code, and ten backup codes. */
export async function setUpApp(
  auth: Auth,
  headers: Headers,
  input: AppPasswordInput
): Promise<AppSetupResult> {
  const parsed = appPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const started = await auth.api.enableTwoFactor({
      body: { method: "totp", password: parsed.data.password },
      headers,
    });
    if (started.method !== "totp") {
      return { ok: false, reason: "unavailable" };
    }
    return {
      backupCodes: started.backupCodes,
      ok: true,
      secret: new URL(started.totpURI).searchParams.get("secret") ?? "",
      uri: started.totpURI,
    };
  } catch (error) {
    return {
      ok: false,
      reason: wrongPassword(error) ? "wrong_password" : "unavailable",
    };
  }
}

/** Puts the authenticator app in force with its first code, which turns the second step on; the session Better Auth re-issues comes back as cookies. */
export async function confirmApp(
  auth: Auth,
  headers: Headers,
  input: AppConfirmInput
): Promise<AppConfirmResult> {
  const parsed = appConfirmSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const confirmed = await auth.api.verifyTOTP({
      body: { code: parsed.data.code },
      headers,
      returnHeaders: true,
    });
    return { ok: true, setCookies: confirmed.headers.getSetCookie() };
  } catch (error) {
    return {
      ok: false,
      reason:
        isAPIError(error) && error.body?.code === "INVALID_CODE"
          ? "wrong_code"
          : "unavailable",
    };
  }
}

/** A new set of ten backup codes after verifying the password; every code of the old set stops working. */
export async function newBackupCodes(
  auth: Auth,
  headers: Headers,
  input: AppPasswordInput
): Promise<BackupCodesResult> {
  const parsed = appPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const renewed = await auth.api.generateBackupCodes({
      body: { password: parsed.data.password },
      headers,
    });
    return { backupCodes: renewed.backupCodes, ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: wrongPassword(error) ? "wrong_password" : "unavailable",
    };
  }
}

/**
 * Turns the authenticator app off after verifying the password: its secret
 * and backup codes go, nothing else. The second step
 * stays on with emailed codes when they could be turned on, a test message
 * having gone through the channel in force; otherwise it goes off with the
 * app, since nothing would be left to sign in with.
 */
export async function turnAppOff(
  auth: Auth,
  headers: Headers,
  storage: SecondStepStorage,
  input: AppPasswordInput
): Promise<SecondStepResult> {
  const parsed = appPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { password } = parsed.data;
  try {
    if (!(await readSecondStep(storage))?.tested) {
      return await switchSecondStep(auth, headers, storage, {
        on: false,
        password,
      });
    }
    // Better Auth's disable turns the whole second step off; it has no way to remove the app alone.
    await auth.api.verifyPassword({ body: { password }, headers });
    await storage.operatorAccount.appOff();
    return { ok: true, setCookies: [] };
  } catch (error) {
    return {
      ok: false,
      reason: wrongPassword(error) ? "wrong_password" : "unavailable",
    };
  }
}
