import { describe, expect, test } from "bun:test";
import { clientNonce, saslPrep, scramConversation } from "./scram.ts";

/** RFC 7677's example conversation for SCRAM-SHA-256. */
const rfc7677 = {
  clientFinal:
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
  nonce: "rOprNGfwEbeRWgbNEkqO",
  serverFinal: "v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
  serverFirst:
    "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096",
};

const salt = /,s=[^,]*/;

function sha256(nonce = rfc7677.nonce, user = "user") {
  return scramConversation("SCRAM-SHA-256", user, "pencil", nonce);
}

/** The code a rejected promise or a throw carries. */
async function codeOf(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return "no error";
}

describe("a SCRAM-SHA-256 sign-in", () => {
  test("follows RFC 7677's example: no channel binding, the proof the password gives, and the server's signature accepted", async () => {
    const conversation = sha256();
    expect(conversation.first).toBe("n,,n=user,r=rOprNGfwEbeRWgbNEkqO");
    expect(await conversation.final(rfc7677.serverFirst)).toBe(
      rfc7677.clientFinal
    );
    expect(() => conversation.verify(rfc7677.serverFinal)).not.toThrow();
  });

  test("refuses a server signature the password does not give, which a server that does not know it sends", async () => {
    const conversation = sha256();
    await conversation.final(rfc7677.serverFirst);
    expect(
      await codeOf(() =>
        conversation.verify("v=AAAATRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")
      )
    ).toBe("ERR_MONGODB_SASL_SIGNATURE_MISMATCH");
  });

  test("refuses a final message that is the server's error, or has no signature", async () => {
    const conversation = sha256();
    await conversation.final(rfc7677.serverFirst);
    expect(await codeOf(() => conversation.verify("e=invalid-proof"))).toBe(
      "ERR_MONGODB_SASL_SERVER_ERROR"
    );
    expect(await codeOf(() => conversation.verify(""))).toBe(
      "ERR_MONGODB_SASL_INVALID_MESSAGE"
    );
  });

  test("refuses a server nonce that does not extend the client's, or only repeats it", async () => {
    expect(
      await codeOf(() =>
        sha256().final(rfc7677.serverFirst.replace("r=rOpr", "r=xOpr"))
      )
    ).toBe("ERR_MONGODB_SASL_NONCE_MISMATCH");
    expect(
      await codeOf(() =>
        sha256().final(
          "r=rOprNGfwEbeRWgbNEkqO,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096"
        )
      )
    ).toBe("ERR_MONGODB_SASL_NONCE_MISMATCH");
  });

  test("refuses fewer than 4096 iterations, or a count that is no number", async () => {
    for (const count of ["4095", "0", "-1", "many", ""]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: one count at a time names the one that passed
        await codeOf(() =>
          sha256().final(rfc7677.serverFirst.replace("i=4096", `i=${count}`))
        )
      ).toBe("ERR_MONGODB_SASL_ITERATIONS_TOO_FEW");
    }
  });

  test("refuses more than 600,000 iterations, which would hold the CPU for minutes", async () => {
    for (const count of ["600001", "4294967295", "100000000000000000000"]) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: one count at a time names the one that passed
        await codeOf(() =>
          sha256().final(rfc7677.serverFirst.replace("i=4096", `i=${count}`))
        )
      ).toBe("ERR_MONGODB_SASL_ITERATIONS_TOO_MANY");
    }
  });

  test("accepts 600,000 iterations, the most it allows", async () => {
    expect(
      await codeOf(() =>
        sha256().final(rfc7677.serverFirst.replace("i=4096", "i=600000"))
      )
    ).toBe("no error");
  });

  test("refuses a first message without its salt", async () => {
    expect(
      await codeOf(() => sha256().final(rfc7677.serverFirst.replace(salt, "")))
    ).toBe("ERR_MONGODB_SASL_INVALID_MESSAGE");
  });

  test("escapes every = and , in the user name and never prepares it", () => {
    expect(sha256("abc", "a=b,c=d,Ⅸ").first).toBe(
      "n,,n=a=3Db=2Cc=3Dd=2CⅨ,r=abc"
    );
  });
});

describe("a client nonce", () => {
  test("is 24 random bytes in base64, a new one each time", () => {
    const nonce = clientNonce();
    expect(Uint8Array.fromBase64(nonce)).toHaveLength(24);
    expect(clientNonce()).not.toBe(nonce);
  });
});

describe("SASLprep", () => {
  // RFC 4013 section 3's examples.
  test.each([
    ["a soft hyphen, mapped to nothing", "I­X", "IX"],
    ["a plain name", "user", "user"],
    ["case kept", "USER", "USER"],
    ["the feminine ordinal, normalized", "ª", "a"],
    ["the roman numeral nine, normalized", "Ⅸ", "IX"],
    ["a non-ASCII space, mapped to a space", "a b", "a b"],
  ])("prepares %s", (_, text, prepared) => {
    expect(saslPrep(text)).toBe(prepared);
  });

  test.each([
    ["a control character", "\u0007"],
    ["a right-to-left string ending in a digit", "ا1"],
    ["right-to-left and left-to-right letters together", "اaا"],
    ["a private-use character", ""],
  ])("refuses %s", async (_, text) => {
    expect(await codeOf(() => saslPrep(text))).toBe(
      "ERR_MONGODB_SASLPREP_PROHIBITED"
    );
  });

  test("accepts a right-to-left password that starts and ends right to left", () => {
    expect(saslPrep("كلمة")).toBe("كلمة");
  });
});
