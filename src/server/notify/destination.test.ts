import { describe, expect, test } from "bun:test";
import {
  type HostLookup,
  isInternetAddress,
  webhookReachable,
} from "./destination.ts";

/** A resolver that answers each name from the table, and fails for any other. */
function resolver(table: Record<string, readonly string[]>): HostLookup {
  return (hostname) => {
    const answer = table[hostname];
    return answer === undefined
      ? Promise.reject(new Error(`no such name ${hostname}`))
      : Promise.resolve(answer);
  };
}

describe("where a visitor's webhook may point", () => {
  test.each([
    ["0.0.0.0"],
    ["10.1.2.3"],
    ["100.64.0.1"],
    ["127.0.0.1"],
    ["169.254.169.254"],
    ["172.16.0.1"],
    ["172.31.255.255"],
    ["192.0.0.1"],
    ["192.0.2.10"],
    ["192.88.99.1"],
    ["192.168.1.1"],
    ["198.18.0.1"],
    ["198.51.100.7"],
    ["203.0.113.9"],
    ["224.0.0.1"],
    ["240.0.0.1"],
    ["255.255.255.255"],
    ["::"],
    ["::1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:10.0.0.1"],
    ["::127.0.0.1"],
    ["::ffff:0:a00:1"],
    ["64:ff9b::a00:1"],
    ["100::1"],
    ["2001:db8::1"],
    ["2002:a00:1::"],
    ["fc00::1"],
    ["fd12:3456::1"],
    ["fe80::1"],
    ["ff02::1"],
  ])("%s is not on the public internet", (address) => {
    expect(isInternetAddress(address)).toBe(false);
  });

  test.each([
    ["1.1.1.1"],
    ["8.8.8.8"],
    ["104.20.23.154"],
    ["172.32.0.1"],
    ["100.128.0.1"],
    ["2606:4700:10::6814:179a"],
    ["2a00:1450:4001::200e"],
  ])("%s is on the public internet", (address) => {
    expect(isInternetAddress(address)).toBe(true);
  });

  test("text that is no address is never on the public internet", () => {
    expect(isInternetAddress("example.com")).toBe(false);
    expect(isInternetAddress("")).toBe(false);
  });

  test("an https name that resolves only to internet addresses may be posted to", async () => {
    const lookup = resolver({
      "hooks.example.com": ["104.20.23.154", "2606:4700:10::6814:179a"],
    });
    expect(
      await webhookReachable("https://hooks.example.com/raaqeb?key=1", lookup)
    ).toBe(true);
  });

  test("an address typed as a public IP is taken without a lookup", async () => {
    const lookup = resolver({});
    expect(await webhookReachable("https://8.8.8.8/hook", lookup)).toBe(true);
    expect(
      await webhookReachable("https://[2a00:1450:4001::200e]:8443/hook", lookup)
    ).toBe(true);
  });

  test("a name with one private address among its answers is refused", async () => {
    const lookup = resolver({
      "mixed.example.com": ["104.20.23.154", "10.0.0.5"],
    });
    expect(await webhookReachable("https://mixed.example.com/", lookup)).toBe(
      false
    );
  });

  test("a private, loopback or metadata address typed as it is refused", async () => {
    const lookup = resolver({});
    for (const url of [
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/",
      "https://[fd00::1]:8443/",
      "https://10.0.0.1:9000/",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each is its own case
      expect(await webhookReachable(url, lookup)).toBe(false);
    }
  });

  test("localhost and every other name that resolves to the machine is refused", async () => {
    const lookup = resolver({ localhost: ["::1", "127.0.0.1"] });
    expect(await webhookReachable("https://localhost:8443/", lookup)).toBe(
      false
    );
  });

  test("a name that does not resolve, or resolves to nothing, is refused", async () => {
    const lookup = resolver({ "empty.example.com": [] });
    expect(await webhookReachable("https://nowhere.example.com/", lookup)).toBe(
      false
    );
    expect(await webhookReachable("https://empty.example.com/", lookup)).toBe(
      false
    );
  });

  test("a name whose lookup never answers is refused once the lookup's time is up", async () => {
    const never: HostLookup = () => new Promise(() => undefined);
    const started = Date.now();
    expect(await webhookReachable("https://slow.example.com/", never, 50)).toBe(
      false
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("plain http, another scheme or text that is no URL is refused", async () => {
    const lookup = resolver({ "hooks.example.com": ["104.20.23.154"] });
    expect(await webhookReachable("http://hooks.example.com/", lookup)).toBe(
      false
    );
    expect(await webhookReachable("ftp://hooks.example.com/", lookup)).toBe(
      false
    );
    expect(await webhookReachable("not a url", lookup)).toBe(false);
  });
});
