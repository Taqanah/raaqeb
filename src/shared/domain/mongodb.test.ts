import { describe, expect, test } from "bun:test";
import {
  mongoUrlFits,
  optionsOf,
  parseConnectionString,
  readOnlyCommandOf,
} from "./mongodb.ts";

/** The options of a URL, typed for the hosts it names. */
function options(url: string) {
  const parsed = parseConnectionString(url);
  return optionsOf(parsed, parsed.hosts.length);
}

describe("a MongoDB connection URL", () => {
  test("names a seed list of hosts, each on its own port or the default one, an IPv6 host without its brackets", () => {
    const parsed = parseConnectionString(
      "mongodb://h1.example.com:27018,[::1],h3.example.com/app?replicaSet=rs0"
    );
    expect(parsed.srv).toBe(false);
    expect(parsed.hosts).toEqual([
      { host: "h1.example.com", port: 27_018 },
      { host: "::1", port: 27_017 },
      { host: "h3.example.com", port: 27_017 },
    ]);
    expect(parsed.database).toBe("app");
  });

  test("decodes the user, the password and the database, and splits the password at the first colon", () => {
    const parsed = parseConnectionString(
      "mongodb://al%3Aice:p%40ss%2Fw%3Ard@db.example.com/my%3Fdb"
    );
    expect(parsed.user).toBe("al:ice");
    expect(parsed.password).toBe("p@ss/w:rd");
    expect(parsed.database).toBe("my?db");
  });

  test("asks to sign in once it has an @, even with an empty user, and has no password without a colon", () => {
    expect(parseConnectionString("mongodb://db.example.com").user).toBe(
      undefined
    );
    expect(parseConnectionString("mongodb://@db.example.com").user).toBe("");
    const named = parseConnectionString("mongodb://alice@db.example.com");
    expect(named.user).toBe("alice");
    expect(named.password).toBe(undefined);
    expect(
      parseConnectionString("mongodb://alice:@db.example.com").password
    ).toBe("");
  });

  test("takes an empty user before the colon and the rest as the password", () => {
    const parsed = parseConnectionString("mongodb://:secret@db.example.com");
    expect(parsed.user).toBe("");
    expect(parsed.password).toBe("secret");
  });

  test("keeps a plus sign in the password as it is", () => {
    expect(
      parseConnectionString("mongodb://u:a+b@db.example.com").password
    ).toBe("a+b");
  });

  test("keys its options in lower case with their values decoded, the last of a repeated key kept with a warning", () => {
    const parsed = parseConnectionString(
      "mongodb://db.example.com/?appName=a%20b&replicaSet=one&REPLICASET=two"
    );
    expect(parsed.options.get("appname")).toBe("a b");
    expect(parsed.options.get("replicaset")).toBe("two");
    expect(parsed.warnings).toHaveLength(1);
  });

  test("may give its options without the slash before them", () => {
    expect(
      parseConnectionString("mongodb://db.example.com?tls=true").options.get(
        "tls"
      )
    ).toBe("true");
    // The options are no part of the database's name.
    expect(
      parseConnectionString("mongodb://db.example.com?tls=true").database
    ).toBe(undefined);
  });

  test("of the SRV scheme names one host and no port", () => {
    const parsed = parseConnectionString(
      "mongodb+srv://u:p@cluster0.abcde.mongodb.net/app"
    );
    expect(parsed.srv).toBe(true);
    expect(parsed.hosts).toEqual([
      { host: "cluster0.abcde.mongodb.net", port: 27_017 },
    ]);
    for (const url of [
      "mongodb+srv://a.example.com,b.example.com",
      "mongodb+srv://cluster0.example.com:27017",
    ]) {
      expect(() => parseConnectionString(url)).toThrow();
    }
  });

  test("takes the lowest and the highest port there is", () => {
    for (const port of [1, 65_535]) {
      expect(
        parseConnectionString(`mongodb://db.example.com:${port}`).hosts
      ).toEqual([{ host: "db.example.com", port }]);
    }
  });

  test.each([
    ["another scheme", "mongo://db.example.com"],
    ["no host", "mongodb://"],
    ["an empty host in the list", "mongodb://a.example.com,,b.example.com"],
    ["a port of zero", "mongodb://db.example.com:0"],
    ["a port past 65535", "mongodb://db.example.com:65536"],
    ["a port with no host", "mongodb://:27017"],
    ["a port that is not a number", "mongodb://db.example.com:port"],
    ["two colons before the port", "mongodb://db.example.com::27017"],
    ["a user with two colons", "mongodb://a:b:c@db.example.com"],
    ["an unescaped @ in the user", "mongodb://a@b@db.example.com"],
    ["a percent sign that encodes nothing", "mongodb://a%zz:b@db.example.com"],
    ["a UNIX socket", "mongodb://%2Ftmp%2Fmongodb-27017.sock"],
    ["a slash in the database", "mongodb://db.example.com/a%2Fb"],
    ["a dollar sign in the database", "mongodb://db.example.com/a$b"],
    ["an option without an equals sign", "mongodb://db.example.com/?tls"],
  ])("is refused with %s", (_, url) => {
    expect(() => parseConnectionString(url)).toThrow();
  });
});

describe("the options the monitor acts on", () => {
  test("read tls or its old name ssl, and refuse the two when they disagree", () => {
    expect(options("mongodb://h/?tls=true").options.tls).toBe(true);
    expect(options("mongodb://h/?ssl=false").options.tls).toBe(false);
    expect(options("mongodb://h/?ssl=true&tls=true").options.tls).toBe(true);
    expect(() => options("mongodb://h/?tls=true&ssl=false")).toThrow();
  });

  test("refuse tlsInsecure beside either of the two it stands for", () => {
    expect(options("mongodb://h/?tlsInsecure=true").options.tlsInsecure).toBe(
      true
    );
    expect(() =>
      options("mongodb://h/?tlsInsecure=true&tlsAllowInvalidHostnames=true")
    ).toThrow();
    expect(() =>
      options(
        "mongodb://h/?tlsAllowInvalidCertificates=false&tlsInsecure=false"
      )
    ).toThrow();
  });

  test("refuse a direct connection to a seed list or an SRV name", () => {
    expect(
      options("mongodb://h/?directConnection=true").options.directConnection
    ).toBe(true);
    expect(() => options("mongodb://a,b/?directConnection=true")).toThrow();
    expect(() =>
      options("mongodb+srv://a.b.c/?directConnection=true")
    ).toThrow();
  });

  test("refuse a load balancer beside several hosts, a replica set or a direct connection", () => {
    expect(options("mongodb://h/?loadBalanced=true").options.loadBalanced).toBe(
      true
    );
    for (const url of [
      "mongodb://a,b/?loadBalanced=true",
      "mongodb://h/?loadBalanced=true&replicaSet=rs",
      "mongodb://h/?loadBalanced=true&directConnection=true",
    ]) {
      expect(() => options(url)).toThrow();
    }
  });

  test("give the SRV options only to an SRV URL, and srvMaxHosts never beside a replica set or a load balancer", () => {
    expect(
      options("mongodb+srv://a.b.c/?srvServiceName=custom&srvMaxHosts=2")
        .options
    ).toMatchObject({ srvMaxHosts: 2, srvServiceName: "custom" });
    for (const url of [
      "mongodb://h/?srvServiceName=custom",
      "mongodb://h/?srvMaxHosts=2",
      "mongodb+srv://a.b.c/?srvMaxHosts=2&replicaSet=rs",
      "mongodb+srv://a.b.c/?srvMaxHosts=2&loadBalanced=true",
    ]) {
      expect(() => options(url)).toThrow();
    }
    expect(
      options("mongodb+srv://a.b.c/?srvMaxHosts=0&replicaSet=rs").options
        .replicaSet
    ).toBe("rs");
  });

  test("refuse an empty authSource", () => {
    expect(() => options("mongodb://h/?authSource=")).toThrow();
    expect(options("mongodb://h/?authSource=other").options.authSource).toBe(
      "other"
    );
  });

  test("ignore a value the monitor cannot read and an option it does not act on, each with a warning", () => {
    const read = options(
      "mongodb+srv://a.b.c/?tls=yes&srvMaxHosts=-1&retryWrites=true&w=majority"
    );
    expect(read.options.tls).toBe(undefined);
    expect(read.options.srvMaxHosts).toBe(undefined);
    expect(read.warnings).toHaveLength(4);
    expect(options("mongodb://h/?tls=true").warnings).toEqual([]);
  });
});

describe("a URL the monitor can check", () => {
  test.each([
    "mongodb://u:p@db.example.com:27017/admin",
    "mongodb://u:p@a.example.com,b.example.com/?replicaSet=rs0&authSource=admin",
    "mongodb+srv://u:p@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0",
    "mongodb://u:p@db.example.com/?authMechanism=SCRAM-SHA-256&tls=true",
    "mongodb://db.example.com",
  ])("is %s", (url) => {
    expect(mongoUrlFits(url)).toBe(true);
  });

  test.each([
    ["a URL of another database", "postgres://u:p@db.example.com/app"],
    ["a URL that does not parse", "mongodb://a:b:c@db.example.com"],
    ["options that conflict", "mongodb://h/?tls=true&ssl=false"],
    [
      "a sign-in that is not SCRAM",
      "mongodb://u:p@h/?authMechanism=MONGODB-X509",
    ],
    [
      "a CA file on the install's disk",
      "mongodb://h/?tls=true&tlsCAFile=ca.pem",
    ],
    [
      "a client certificate file",
      "mongodb://h/?tls=true&tlsCertificateKeyFile=client.pem",
    ],
    ["a SOCKS5 proxy", "mongodb://h/?proxyHost=proxy.example.com"],
    ["a user without a password, which SCRAM needs", "mongodb://alice@h"],
    ["an empty user", "mongodb://:secret@h"],
    ["a mechanism without a user", "mongodb://h/?authMechanism=SCRAM-SHA-256"],
  ])("is not %s", (_, url) => {
    expect(mongoUrlFits(url)).toBe(false);
  });
});

describe("a MongoDB command", () => {
  test("is a JSON document whose first key is a command that only reads", () => {
    expect(readOnlyCommandOf('{"ping": 1}')).toBe("ping");
    expect(
      readOnlyCommandOf('{"count": "orders", "query": {"open": true}}')
    ).toBe("count");
    expect(readOnlyCommandOf(' {"dbstats": 1} ')).toBe("dbStats");
  });

  test.each([
    ["a command that writes", '{"insert": "orders", "documents": [{}]}'],
    ["a command that deletes", '{"dropDatabase": 1}'],
    ["a pipeline, which can write", '{"aggregate": "orders", "pipeline": []}'],
    ["a read-only command after another key", '{"$db": "admin", "ping": 1}'],
    ["an empty document", "{}"],
    ["an array", '[{"ping": 1}]'],
    ["a JSON value that is no document", "null"],
    ["a JSON string", '"ping"'],
    ["a JSON number", "5"],
    ["text that is not JSON", "ping"],
    ["two documents", '{"ping": 1} {"ping": 1}'],
  ])("is not %s", (_, text) => {
    expect(readOnlyCommandOf(text)).toBe(undefined);
  });
});
