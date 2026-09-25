import ipaddr from "ipaddr.js";

export type AddressClass = "public" | "private" | "loopback" | "link_local" | "reserved" | "multicast";

type IPv4 = InstanceType<typeof ipaddr.IPv4>;
type IPv6 = InstanceType<typeof ipaddr.IPv6>;

// NAT64 well-known prefix (RFC 6052): the low 32 bits carry an IPv4 address.
const NAT64_WKP = ipaddr.IPv6.parseCIDR("64:ff9b::/96");
// Only the IPv6 global unicast block may ever be public. Anything outside it
// (e.g. the deprecated IPv4-compatible ::a.b.c.d form, which ipaddr.js labels
// "unicast") is treated as reserved.
const IPV6_GLOBAL_UNICAST = ipaddr.IPv6.parseCIDR("2000::/3");

function classifyV4(addr: IPv4): AddressClass {
  // Cast: ipaddr.js's declared range unions omit some names it actually returns.
  switch (addr.range() as string) {
    case "unicast":
      return "public";
    case "private":
    case "carrierGradeNat":
      return "private";
    case "loopback":
      return "loopback";
    case "linkLocal":
      return "link_local";
    case "multicast":
      return "multicast";
    // unspecified (0.0.0.0/8), broadcast, reserved (documentation, benchmarking,
    // 240/4, 192.0.0/24 …), as112, amt, and anything ipaddr.js adds later.
    default:
      return "reserved";
  }
}

function classifyV6(addr: IPv6): AddressClass {
  if (addr.isIPv4MappedAddress()) return classifyV4(addr.toIPv4Address());
  if (addr.match(NAT64_WKP)) {
    return classifyV4(new ipaddr.IPv4(addr.toByteArray().slice(12)));
  }
  switch (addr.range() as string) {
    case "unicast":
      return addr.match(IPV6_GLOBAL_UNICAST) ? "public" : "reserved";
    case "uniqueLocal":
    case "deprecatedSiteLocal":
      return "private";
    case "loopback":
      return "loopback";
    case "linkLocal":
      return "link_local";
    case "multicast":
      return "multicast";
    // unspecified, 6to4, teredo, rfc6145, local-use NAT64 (64:ff9b:1::/48),
    // benchmarking, documentation, discard, ORCHID, AMT, AS112, segment routing …
    default:
      return "reserved";
  }
}

/**
 * Classify an IP address. Only `"public"` may be connected to.
 *
 * IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::/96`) IPv6 addresses are
 * unwrapped and classified as the embedded IPv4 address. Non-canonical IPv4
 * forms (`2130706433`, `0177.0.0.1`, `0x7f.1`) are parsed the same way the
 * WHATWG URL parser does. Input that is not an IP address is classified as
 * `"reserved"` (fail closed) rather than throwing.
 */
export function classifyAddress(ip: string): AddressClass {
  let parsed: IPv4 | IPv6;
  try {
    parsed = ipaddr.parse(ip.trim());
  } catch {
    return "reserved";
  }
  return parsed.kind() === "ipv4" ? classifyV4(parsed as IPv4) : classifyV6(parsed as IPv6);
}

export function isPublicAddress(ip: string): boolean {
  return classifyAddress(ip) === "public";
}
