import { describe, expect, test } from "bun:test";
import {
  createRegistrationReader,
  directoryLifetimeMs,
  ianaWhoisServer,
  type RegistrationIo,
  rdapBootstrapUrl,
  registeredDomain,
  registrationReadDue,
} from "./registration.ts";

const day = 86_400_000;
/** 2026-10-18T12:00:00Z, the day the fixtures were captured. */
const now = Date.UTC(2026, 9, 18, 12);

const fixture = (path: string): Promise<string> =>
  Bun.file(`${import.meta.dir}/fixtures/${path}`).text();

/** IANA's bootstrap file in its own shape, cut to the TLDs these tests use; one base URL has no final slash. */
const bootstrap = JSON.stringify({
  description: "RDAP bootstrap file for Domain Name System registrations",
  publication: "2026-09-30T23:00:03Z",
  services: [
    [["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
    [["ly"], ["https://rdap.nic.ly/"]],
    [["uk"], ["https://rdap.nominet.uk/uk/"]],
    [["bh"], ["https://rdap.bhregistry.bh/rdap/"]],
    [["in"], ["https://rdap.nixiregistry.in/rdap/"]],
    [["br"], ["https://rdap.registro.br/"]],
    [["name"], ["https://tld-rdap.verisign.com/name/v1/"]],
    [["dev"], ["https://pubapi.registry.google/rdap"]],
  ],
  version: "1.0",
});

type Answer = string | number | Error;

/** A fake registry world on a clock the test moves: each URL's body (or status, or failure) and each WHOIS server's answers by query; every ask, in order. */
function world(
  rdap: Readonly<Record<string, Answer>>,
  whois: Readonly<Record<string, Answer>> = {}
) {
  const asked: string[] = [];
  const accepts: string[] = [];
  let clock = now;
  const answer = (found: Answer | undefined, key: string): Answer => {
    if (found === undefined) {
      throw new Error(`the fake world has no answer for ${key}`);
    }
    return found;
  };
  const io: RegistrationIo = {
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      accepts.push(new Headers(init?.headers).get("accept") ?? "");
      const found = answer(
        url === rdapBootstrapUrl ? (rdap[url] ?? bootstrap) : rdap[url],
        url
      );
      if (found instanceof Error) {
        return Promise.reject(found);
      }
      return Promise.resolve(
        typeof found === "number"
          ? new Response("{}", { status: found })
          : new Response(found, {
              headers: { "content-type": "application/rdap+json" },
            })
      );
    }) as typeof fetch,
    now: () => clock,
    whois: (server, query) => {
      asked.push(`whois ${server} ${query}`);
      const found = answer(whois[`${server} ${query}`], `${server} ${query}`);
      return found instanceof Error
        ? Promise.reject(found)
        : Promise.resolve(String(found));
    },
  };
  return {
    accepts,
    asked,
    at: (at: number) => {
      clock = at;
    },
    io,
  };
}

const verisign = "https://rdap.verisign.com/com/v1/domain/";
const nixi = "https://rdap.nixiregistry.in/rdap/domain/";
const registroBr = "https://rdap.registro.br/domain/";

describe("the registered domain, the one name a registry is asked", () => {
  test("the public suffix and one label more: nothing under it leaves the install", () => {
    expect(registeredDomain("jenkins.corp.acme.com")).toBe("acme.com");
    expect(registeredDomain("www.rri.res.in")).toBe("rri.res.in");
    expect(registeredDomain("www.camara.leg.br")).toBe("camara.leg.br");
    expect(registeredDomain("www.example.co.uk")).toBe("example.co.uk");
    expect(registeredDomain("www.google.it")).toBe("google.it");
    expect(registeredDomain("raaqeb.dev")).toBe("raaqeb.dev");
  });

  test("a host that is itself a public suffix has none", () => {
    expect(registeredDomain("co.uk")).toBeUndefined();
    expect(registeredDomain("res.in")).toBeUndefined();
  });

  test("the list's private section is left out: its names are registrations a registry holds", () => {
    expect(registeredDomain("raaqeb.github.io")).toBe("github.io");
    expect(registeredDomain("a.b.example.uk.com")).toBe("uk.com");
  });

  // The list's own test vectors (publicsuffix/list, tests/tests.txt), in the lower case, punycode shape a host arrives in.
  test.each([
    ["com", undefined],
    ["example", undefined],
    ["example.example", "example.example"],
    ["b.example.example", "example.example"],
    ["a.b.example.example", "example.example"],
    ["biz", undefined],
    ["domain.biz", "domain.biz"],
    ["a.b.domain.biz", "domain.biz"],
    ["example.com", "example.com"],
    ["a.b.example.com", "example.com"],
    ["test.ac", "test.ac"],
    ["mm", undefined],
    ["c.mm", undefined],
    ["b.c.mm", "b.c.mm"],
    ["a.b.c.mm", "b.c.mm"],
    ["jp", undefined],
    ["test.jp", "test.jp"],
    ["www.test.jp", "test.jp"],
    ["ac.jp", undefined],
    ["test.ac.jp", "test.ac.jp"],
    ["www.test.ac.jp", "test.ac.jp"],
    ["kyoto.jp", undefined],
    ["test.kyoto.jp", "test.kyoto.jp"],
    ["ide.kyoto.jp", undefined],
    ["b.ide.kyoto.jp", "b.ide.kyoto.jp"],
    ["a.b.ide.kyoto.jp", "b.ide.kyoto.jp"],
    ["c.kobe.jp", undefined],
    ["b.c.kobe.jp", "b.c.kobe.jp"],
    ["a.b.c.kobe.jp", "b.c.kobe.jp"],
    ["city.kobe.jp", "city.kobe.jp"],
    ["www.city.kobe.jp", "city.kobe.jp"],
    ["ck", undefined],
    ["test.ck", undefined],
    ["b.test.ck", "b.test.ck"],
    ["a.b.test.ck", "b.test.ck"],
    ["www.ck", "www.ck"],
    ["www.www.ck", "www.ck"],
    ["us", undefined],
    ["test.us", "test.us"],
    ["www.test.us", "test.us"],
    ["ak.us", undefined],
    ["test.ak.us", "test.ak.us"],
    ["www.test.ak.us", "test.ak.us"],
    ["k12.ak.us", undefined],
    ["test.k12.ak.us", "test.k12.ak.us"],
    ["www.test.k12.ak.us", "test.k12.ak.us"],
    ["xn--85x722f.com.cn", "xn--85x722f.com.cn"],
    ["xn--85x722f.xn--55qx5d.cn", "xn--85x722f.xn--55qx5d.cn"],
    ["www.xn--85x722f.xn--55qx5d.cn", "xn--85x722f.xn--55qx5d.cn"],
    ["shishi.xn--55qx5d.cn", "shishi.xn--55qx5d.cn"],
    ["xn--55qx5d.cn", undefined],
    ["xn--85x722f.xn--fiqs8s", "xn--85x722f.xn--fiqs8s"],
    ["www.xn--85x722f.xn--fiqs8s", "xn--85x722f.xn--fiqs8s"],
    ["shishi.xn--fiqs8s", "shishi.xn--fiqs8s"],
    ["xn--fiqs8s", undefined],
  ])("%s is under %s", (host, domain) => {
    expect(registeredDomain(host)).toBe(domain);
  });
});

describe("a registration read over RDAP", () => {
  test("no name under the registered domain leaves the install: an internal host under a .com domain asks for the domain alone", async () => {
    const { asked, io } = world({
      [`${verisign}jenkins.corp.google.com`]: 404,
      [`${verisign}corp.google.com`]: 404,
      [`${verisign}google.com`]: await fixture("rdap/google.com.json"),
    });
    expect(
      await createRegistrationReader(io).read("jenkins.corp.google.com")
    ).toEqual({
      domain: "google.com",
      expiresAt: Date.UTC(2028, 8, 14, 4),
    });
    expect(asked).toEqual([rdapBootstrapUrl, `${verisign}google.com`]);
  });

  test("a zone the registry keeps a record of is not read as the registration under it: www.rri.res.in asks rri.res.in alone", async () => {
    // NIXI holds res.in itself, with an expiry in 2035.
    const { asked, io } = world({
      [`${nixi}res.in`]: await fixture("rdap/res.in.json"),
      [`${nixi}rri.res.in`]: await fixture("rdap/rri.res.in.json"),
    });
    expect(await createRegistrationReader(io).read("www.rri.res.in")).toEqual({
      domain: "rri.res.in",
      expiresAt: Date.UTC(2028, 1, 28, 5),
    });
    expect(asked).toEqual([rdapBootstrapUrl, `${nixi}rri.res.in`]);
  });

  test("a category zone of registro.br is not read as the registration under it: www.camara.leg.br asks camara.leg.br alone", async () => {
    const { asked, io } = world({
      [`${registroBr}leg.br`]: await fixture("rdap/leg.br.json"),
      [`${registroBr}camara.leg.br`]: await fixture("rdap/camara.leg.br.json"),
    });
    expect(
      await createRegistrationReader(io).read("www.camara.leg.br")
    ).toEqual({ domain: "camara.leg.br", expiresAt: undefined });
    expect(asked).toEqual([rdapBootstrapUrl, `${registroBr}camara.leg.br`]);
  });

  test("a host under a zone the list names asks the name directly under the zone, and nothing longer", async () => {
    const { asked, io } = world({
      "https://rdap.nic.ly/domain/shop.med.ly": JSON.stringify({
        events: [
          { eventAction: "expiration", eventDate: "2027-01-01T00:00:00Z" },
        ],
        ldhName: "shop.med.ly",
      }),
    });
    expect(
      await createRegistrationReader(io).read("api.www.shop.med.ly")
    ).toEqual({ domain: "shop.med.ly", expiresAt: Date.UTC(2027, 0, 1) });
    expect(asked).toEqual([
      rdapBootstrapUrl,
      "https://rdap.nic.ly/domain/shop.med.ly",
    ]);
  });

  test("a registry that refuses a name as a bad request holds no such name", async () => {
    const { io } = world({ "https://rdap.nic.ly/domain/typo.med.ly": 400 });
    expect(await createRegistrationReader(io).read("www.typo.med.ly")).toEqual({
      domain: undefined,
      expiresAt: undefined,
    });
  });

  test("a host under a zone a ccTLD's registry runs asks for the three-label name alone", async () => {
    const { asked, io } = world({
      "https://rdap.bhregistry.bh/rdap/domain/google.com.bh": await fixture(
        "rdap/www.google.com.bh.json"
      ),
    });
    expect(
      await createRegistrationReader(io).read("www.google.com.bh")
    ).toEqual({
      domain: "google.com.bh",
      expiresAt: Date.parse("2027-10-18T23:59:59.000Z"),
    });
    expect(asked).toEqual([
      rdapBootstrapUrl,
      "https://rdap.bhregistry.bh/rdap/domain/google.com.bh",
    ]);
  });

  test("a record that names no domain is no registration: .name answers smith.name, a shared second level, with an empty record", async () => {
    const { asked, io } = world({
      "https://tld-rdap.verisign.com/name/v1/domain/smith.name": await fixture(
        "rdap/smith.name.json"
      ),
    });
    expect(await createRegistrationReader(io).read("david.smith.name")).toEqual(
      { domain: undefined, expiresAt: undefined }
    );
    expect(asked).toEqual([
      rdapBootstrapUrl,
      "https://tld-rdap.verisign.com/name/v1/domain/smith.name",
    ]);
  });

  test("a record that names another domain than the one asked is no registration: only a name the host is under is ever stored", async () => {
    const { io } = world({
      [`${verisign}google.com`]: JSON.stringify({
        events: [
          { eventAction: "expiration", eventDate: "2027-01-01T00:00:00Z" },
        ],
        ldhName: "Text Of The Server's Choosing",
      }),
    });
    expect(await createRegistrationReader(io).read("www.google.com")).toEqual({
      domain: undefined,
      expiresAt: undefined,
    });
  });

  test("a registration whose registry gives no expiry date has an unknown date", async () => {
    const { io } = world({
      "https://rdap.nominet.uk/uk/domain/shop.example.uk": 404,
      "https://rdap.nominet.uk/uk/domain/example.uk": JSON.stringify({
        events: [{ eventAction: "registration", eventDate: "2015-01-01Z" }],
        ldhName: "example.uk",
      }),
    });
    expect(await createRegistrationReader(io).read("shop.example.uk")).toEqual({
      domain: "example.uk",
      expiresAt: undefined,
    });
  });

  test("an expiry date more than 90 days gone cannot be a registration in use, so it is unknown", async () => {
    const { io } = world({
      "https://rdap.nic.ly/domain/lapsed.ly": JSON.stringify({
        events: [
          { eventAction: "expiration", eventDate: "2021-10-20T12:13:52Z" },
        ],
        ldhName: "lapsed.ly",
      }),
    });
    expect(await createRegistrationReader(io).read("lapsed.ly")).toEqual({
      domain: "lapsed.ly",
      expiresAt: undefined,
    });
  });

  test("an expiry date exactly 90 days gone is kept", async () => {
    const expiresAt = now - 90 * day;
    const { io } = world({
      "https://rdap.nic.ly/domain/lapsed.ly": JSON.stringify({
        events: [
          {
            eventAction: "expiration",
            eventDate: new Date(expiresAt).toISOString(),
          },
        ],
        ldhName: "lapsed.ly",
      }),
    });
    expect(await createRegistrationReader(io).read("lapsed.ly")).toEqual({
      domain: "lapsed.ly",
      expiresAt,
    });
  });

  test("a zone a ccTLD's registry runs for others is never asked, so a name not registered under it never reads as the registry's own record", async () => {
    // .ly holds com.ly itself, with an expiry in 2021, and .lb holds com.lb, expiring in 2099.
    const { asked, io } = world({
      "https://rdap.nic.ly/domain/typo.com.ly": 404,
      "https://rdap.nic.ly/domain/com.ly": await fixture("rdap/com.ly.json"),
    });
    expect(await createRegistrationReader(io).read("typo.com.ly")).toEqual({
      domain: undefined,
      expiresAt: undefined,
    });
    expect(asked).toEqual([
      rdapBootstrapUrl,
      "https://rdap.nic.ly/domain/typo.com.ly",
    ]);
  });

  test("an expiry date that has just passed is kept, so the warning still goes", async () => {
    const { io } = world({
      [`${verisign}example.com`]: JSON.stringify({
        events: [
          { eventAction: "expiration", eventDate: "2026-10-01T00:00:00Z" },
        ],
        ldhName: "EXAMPLE.COM",
      }),
    });
    expect(await createRegistrationReader(io).read("example.com")).toEqual({
      domain: "example.com",
      expiresAt: Date.UTC(2026, 9, 1),
    });
  });

  test("a host no registry holds a name of has neither a domain nor a date", async () => {
    const { io } = world({
      [`${verisign}nowhere-raaqeb.com`]: 404,
    });
    expect(
      await createRegistrationReader(io).read("www.nowhere-raaqeb.com")
    ).toEqual({ domain: undefined, expiresAt: undefined });
  });

  test("a registry that fails is no answer", async () => {
    const { asked, io } = world({
      "https://rdap.nic.ly/domain/gob.ly": 503,
    });
    expect(
      await createRegistrationReader(io).read("shop.gob.ly")
    ).toBeUndefined();
    expect(asked).toEqual([
      rdapBootstrapUrl,
      "https://rdap.nic.ly/domain/gob.ly",
    ]);
  });

  test("a registry that cannot be reached, or answers what is not JSON, is no answer", async () => {
    const unreachable = world({
      [`${verisign}google.com`]: new Error("connect ECONNREFUSED"),
    });
    expect(
      await createRegistrationReader(unreachable.io).read("google.com")
    ).toBeUndefined();
    const garbled = world({ [`${verisign}google.com`]: "<html>" });
    expect(
      await createRegistrationReader(garbled.io).read("google.com")
    ).toBeUndefined();
  });

  test("RDAP is asked for its own media type", async () => {
    const { accepts, io } = world({
      [`${verisign}google.com`]: await fixture("rdap/google.com.json"),
    });
    await createRegistrationReader(io).read("google.com");
    expect(accepts.at(-1)).toBe("application/rdap+json");
  });
});

describe("a registration read over WHOIS, for a TLD with no RDAP server", () => {
  test("IANA names the TLD's WHOIS server, which is asked for the registered name alone", async () => {
    const { asked, io } = world(
      {},
      {
        [`${ianaWhoisServer} ma`]:
          "refer:        whois.registre.ma\n\ndomain:       MA\n\nwhois:        whois.registre.ma\n",
        "whois.registre.ma google.co.ma": await fixture(
          "whois/google.co.ma.txt"
        ),
      }
    );
    expect(await createRegistrationReader(io).read("www.google.co.ma")).toEqual(
      {
        domain: "google.co.ma",
        expiresAt: Date.UTC(2027, 0, 29),
      }
    );
    expect(asked).toEqual([
      rdapBootstrapUrl,
      `whois ${ianaWhoisServer} ma`,
      "whois whois.registre.ma google.co.ma",
    ]);
  });

  test("a registry that publishes no expiry date gives its record's domain with an unknown date", async () => {
    const { asked, io } = world(
      {},
      {
        [`${ianaWhoisServer} qa`]: await fixture("whois/iana-qa.txt"),
        "whois.registry.qa google.com.qa": await fixture(
          "whois/google.com.qa.txt"
        ),
      }
    );
    expect(
      await createRegistrationReader(io).read("www.google.com.qa")
    ).toEqual({ domain: "google.com.qa", expiresAt: undefined });
    expect(asked).toHaveLength(3);
  });

  test("a host the registry does not hold, under a zone it runs, is unknown: the registry's own record of the zone is never read", async () => {
    const { asked, io } = world(
      {},
      {
        [`${ianaWhoisServer} mx`]: "domain:       MX\nwhois:        whois.mx\n",
        "whois.mx qwzx-raaqeb-none.com.mx": await fixture(
          "whois/mx-not-held.txt"
        ),
        "whois.mx com.mx": await fixture("whois/mx-second-level.txt"),
      }
    );
    expect(
      await createRegistrationReader(io).read("qwzx-raaqeb-none.com.mx")
    ).toEqual({ domain: undefined, expiresAt: undefined });
    expect(asked).toEqual([
      rdapBootstrapUrl,
      `whois ${ianaWhoisServer} mx`,
      "whois whois.mx qwzx-raaqeb-none.com.mx",
    ]);
  });

  test("a host under a zone .qa runs, which holds no record of the zone (com.qa), asks the name under the zone alone", async () => {
    const { asked, io } = world(
      {},
      {
        [`${ianaWhoisServer} qa`]: await fixture("whois/iana-qa.txt"),
        "whois.registry.qa google.com.qa": await fixture(
          "whois/google.com.qa.txt"
        ),
      }
    );
    expect(
      await createRegistrationReader(io).read("www.google.com.qa")
    ).toEqual({ domain: "google.com.qa", expiresAt: undefined });
    expect(asked).toEqual([
      rdapBootstrapUrl,
      `whois ${ianaWhoisServer} qa`,
      "whois whois.registry.qa google.com.qa",
    ]);
  });

  test("an answer that is neither a record nor a not-found is no answer", async () => {
    const { asked, io } = world(
      {},
      {
        [`${ianaWhoisServer} qa`]: await fixture("whois/iana-qa.txt"),
        "whois.registry.qa google.com.qa":
          "% Query rate limit exceeded. Please wait 60 seconds.\n",
      }
    );
    expect(
      await createRegistrationReader(io).read("www.google.com.qa")
    ).toBeUndefined();
    expect(asked).toHaveLength(3);
  });

  test("a host under a domain asks for the domain alone, whose record is read as itself", async () => {
    const { asked, io } = world(
      {},
      {
        [`${ianaWhoisServer} de`]:
          "domain:       DE\nwhois:        whois.denic.de\n",
        "whois.denic.de google.de": await fixture("whois/google.de.txt"),
      }
    );
    expect(await createRegistrationReader(io).read("www.google.de")).toEqual({
      domain: "google.de",
      expiresAt: undefined,
    });
    expect(asked).toEqual([
      rdapBootstrapUrl,
      `whois ${ianaWhoisServer} de`,
      "whois whois.denic.de google.de",
    ]);
  });

  test("an IANA answer that is no record of the TLD is no answer, and the next read asks IANA again", async () => {
    const whois: Record<string, Answer> = {
      [`${ianaWhoisServer} so`]: "% Too many queries; try again later.\n",
      "whois.nic.so google.so": await fixture("whois/google.so.txt"),
    };
    const { asked, io } = world({}, whois);
    const reader = createRegistrationReader(io);
    expect(await reader.read("google.so")).toBeUndefined();
    whois[`${ianaWhoisServer} so`] =
      "domain:       SO\nwhois:        whois.nic.so\n";
    expect(await reader.read("google.so")).toEqual({
      domain: "google.so",
      expiresAt: Date.UTC(2027, 0, 24),
    });
    expect(
      asked.filter((each) => each === `whois ${ianaWhoisServer} so`)
    ).toHaveLength(2);
  });

  test("an expiry line whose date does not read gives an unknown date", async () => {
    const { asked, io } = world(
      {},
      {
        [`${ianaWhoisServer} dz`]:
          "domain:       DZ\nwhois:        whois.nic.dz\n",
        "whois.nic.dz google.dz": await fixture("whois/google.dz.txt"),
      }
    );
    expect(await createRegistrationReader(io).read("google.dz")).toEqual({
      domain: "google.dz",
      expiresAt: undefined,
    });
    expect(asked).toHaveLength(3);
  });

  test("a TLD with no WHOIS server has an unknown registration, and nothing more is asked", async () => {
    const { asked, io } = world(
      {},
      { [`${ianaWhoisServer} eg`]: await fixture("whois/iana-eg.txt") }
    );
    expect(
      await createRegistrationReader(io).read("www.google.com.eg")
    ).toEqual({ domain: undefined, expiresAt: undefined });
    expect(asked).toEqual([rdapBootstrapUrl, `whois ${ianaWhoisServer} eg`]);
  });

  test("a WHOIS server that cannot be reached is no answer", async () => {
    const { io } = world(
      {},
      {
        [`${ianaWhoisServer} so`]:
          "domain:       SO\nwhois:        whois.nic.so\n",
        "whois.nic.so google.so": new Error("connect ETIMEDOUT"),
      }
    );
    expect(
      await createRegistrationReader(io).read("google.so")
    ).toBeUndefined();
  });

  test("IANA that cannot be reached is no answer", async () => {
    const { io } = world(
      {},
      { [`${ianaWhoisServer} so`]: new Error("connect ETIMEDOUT") }
    );
    expect(
      await createRegistrationReader(io).read("google.so")
    ).toBeUndefined();
  });

  test("the bootstrap file that cannot be read is no answer", async () => {
    const { asked, io } = world({ [rdapBootstrapUrl]: 503 });
    expect(
      await createRegistrationReader(io).read("google.com")
    ).toBeUndefined();
    expect(asked).toEqual([rdapBootstrapUrl]);
  });
});

describe("what the reader keeps", () => {
  test("monitors under one domain ask its registry once a UTC day", async () => {
    const { asked, at, io } = world({
      [`${verisign}www.google.com`]: 404,
      [`${verisign}mail.google.com`]: 404,
      [`${verisign}google.com`]: await fixture("rdap/google.com.json"),
    });
    const reader = createRegistrationReader(io);
    await reader.read("www.google.com");
    await reader.read("mail.google.com");
    await reader.read("www.google.com");
    expect(asked.filter((url) => url === `${verisign}google.com`)).toHaveLength(
      1
    );
    at(Date.UTC(2026, 9, 19));
    await reader.read("mail.google.com");
    expect(asked.filter((url) => url === `${verisign}google.com`)).toHaveLength(
      2
    );
  });

  test("a failed answer is not kept, so the next read asks again", async () => {
    const rdap: Record<string, Answer> = { [`${verisign}google.com`]: 503 };
    const { asked, io } = world(rdap);
    const reader = createRegistrationReader(io);
    expect(await reader.read("google.com")).toBeUndefined();
    rdap[`${verisign}google.com`] = await fixture("rdap/google.com.json");
    expect(await reader.read("google.com")).toEqual({
      domain: "google.com",
      expiresAt: Date.UTC(2028, 8, 14, 4),
    });
    expect(asked.filter((url) => url === `${verisign}google.com`)).toHaveLength(
      2
    );
  });

  test("the bootstrap file and the WHOIS servers are read again only after a week", async () => {
    const { asked, at, io } = world(
      {
        [`${verisign}google.com`]: await fixture("rdap/google.com.json"),
      },
      {
        [`${ianaWhoisServer} so`]:
          "domain:       SO\nwhois:        whois.nic.so\n",
        "whois.nic.so google.so": await fixture("whois/google.so.txt"),
      }
    );
    const reader = createRegistrationReader(io);
    const directory = () =>
      asked.filter(
        (each) =>
          each === rdapBootstrapUrl || each === `whois ${ianaWhoisServer} so`
      ).length;
    await reader.read("google.com");
    await reader.read("google.so");
    expect(directory()).toBe(2);
    at(now + day);
    await reader.read("google.com");
    await reader.read("google.so");
    expect(directory()).toBe(2);
    at(now + directoryLifetimeMs);
    await reader.read("google.com");
    await reader.read("google.so");
    expect(directory()).toBe(4);
  });
});

describe("when a registration is read", () => {
  test("a monitor with none is due at once", () => {
    expect(registrationReadDue(undefined, now)).toBe(true);
  });

  test("one read earlier this UTC day is not due", () => {
    expect(registrationReadDue({ readAt: Date.UTC(2026, 9, 18) }, now)).toBe(
      false
    );
  });

  test("one read on an earlier UTC day is due from midnight", () => {
    const readAt = Date.UTC(2026, 9, 17, 23, 59);
    expect(registrationReadDue({ readAt }, Date.UTC(2026, 9, 18))).toBe(true);
    expect(registrationReadDue({ readAt }, Date.UTC(2026, 9, 18) - 1)).toBe(
      false
    );
  });
});
