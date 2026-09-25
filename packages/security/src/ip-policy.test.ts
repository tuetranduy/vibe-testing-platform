import { describe, expect, it } from "vitest";
import { classifyAddress, isPublicAddress } from "./ip-policy";

describe("classifyAddress", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["93.184.215.14", "public"],
    ["2606:4700:4700::1111", "public"],
    ["2a00:1450:4001:80b::200e", "public"],
  ] as const)("%s is %s", (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["::1", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.10", "private"],
    ["100.64.0.1", "private"], // CGNAT
    ["fd00::1", "private"], // unique local
    ["fc00::1", "private"],
    ["fec0::1", "private"], // deprecated site-local
    ["169.254.169.254", "link_local"],
    ["fe80::1", "link_local"],
    ["fe80::1%eth0", "link_local"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["ff02::1", "multicast"],
    ["0.0.0.0", "reserved"],
    ["0.1.2.3", "reserved"],
    ["255.255.255.255", "reserved"],
    ["240.0.0.1", "reserved"],
    ["192.0.2.1", "reserved"], // TEST-NET-1
    ["198.51.100.1", "reserved"], // TEST-NET-2
    ["203.0.113.1", "reserved"], // TEST-NET-3
    ["198.18.0.1", "reserved"], // benchmarking
    ["192.0.0.1", "reserved"],
    ["::", "reserved"],
    ["2001:db8::1", "reserved"], // documentation
    ["2001:2::1", "reserved"], // benchmarking
    ["2002:7f00:1::1", "reserved"], // 6to4
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "reserved"], // teredo
    ["100::1", "reserved"], // discard
    ["::7f00:1", "reserved"], // deprecated IPv4-compatible, outside 2000::/3
    ["64:ff9b:1::a00:1", "reserved"], // local-use NAT64 prefix
  ] as const)("%s is %s", (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  describe("unwraps embedded IPv4", () => {
    it.each([
      ["::ffff:127.0.0.1", "loopback"],
      ["::ffff:7f00:1", "loopback"],
      ["::ffff:10.0.0.1", "private"],
      ["::ffff:169.254.169.254", "link_local"],
      ["::ffff:8.8.8.8", "public"],
      ["64:ff9b::a00:1", "private"], // NAT64 → 10.0.0.1
      ["64:ff9b::7f00:1", "loopback"], // NAT64 → 127.0.0.1
      ["64:ff9b::a9fe:a9fe", "link_local"], // NAT64 → 169.254.169.254
      ["64:ff9b::808:808", "public"], // NAT64 → 8.8.8.8
    ] as const)("%s is %s", (ip, expected) => {
      expect(classifyAddress(ip)).toBe(expected);
    });
  });

  describe("non-canonical IPv4 forms are interpreted like the WHATWG URL parser", () => {
    it.each(["2130706433", "0177.0.0.1", "0x7f.1", "127.1"])("%s is loopback", (ip) => {
      expect(classifyAddress(ip)).toBe("loopback");
    });
  });

  it("fails closed on garbage input (reserved, never public)", () => {
    expect(classifyAddress("not-an-ip")).toBe("reserved");
    expect(classifyAddress("")).toBe("reserved");
    expect(classifyAddress("999.1.1.1")).toBe("reserved");
  });

  it("isPublicAddress is true only for public", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
  });
});
