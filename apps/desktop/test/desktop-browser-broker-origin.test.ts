import { describe, expect, it } from "vitest";
import { windowsInstallerOriginHashes } from "../src/desktop-browser-broker-client.js";

describe("Windows installer origin directory compatibility", () => {
  it("keeps scheme and port distinct after default-port normalization", () => {
    expect(windowsInstallerOriginHashes("http://Example.COM:80/")).toEqual([
      "f0e6a6a97042a4f1f1c87f5f7d44315b2d852c2df5c7991cc66241bf7072d1c4",
    ]);
    expect(windowsInstallerOriginHashes("https://Example.COM:443/")).toEqual([
      "100680ad546ce6a577f42f52df33b4cfdca756859e664b8d7de329b150d09ce9",
    ]);
    expect(windowsInstallerOriginHashes("https://example.com:8443/")).toEqual([
      "20ba33b878e5f5c63bf18aa8a6d5a7a27ad7104710fd0e896ec822bdefb1289d",
    ]);
  });

  it("includes actual PowerShell 5.1 and 7 Unicode-host installer hashes", () => {
    expect(windowsInstallerOriginHashes("http://bücher.example/")).toEqual([
      "284bc51388b8dc6c73086581c4bffe47c99aedf8688513339dd74e7c4bbec4f9",
      "74cfc7db82d6cc0c897cb4d4d086662563c0b3b32190960b58318401f125d8ed",
    ]);
    expect(windowsInstallerOriginHashes("https://пример.рф/")).toEqual([
      "0d8896630b4bda5a4071a6274a88a51de16761315af8e48d7f6c959d2134acdf",
      "b8be77477b9cde5c80cd3bffa2a8ede83c1fad6ba01e4a77ed7f725ec58a91ae",
    ]);
  });

  it("includes the expanded PowerShell 5.1 IPv6 hash", () => {
    expect(windowsInstallerOriginHashes("http://[::1]:38886/")).toEqual([
      "89f7e7ac539dfb2ef726e20658d09121c1dd367a914cd83989e9a3cd469249c5",
      "feb106ac4eda7cc5c8486273a2e1e3fdf5de73e980f0935068ac985104ff4efa",
    ]);
    expect(
      windowsInstallerOriginHashes("https://[2001:db8::ab:1]:8443/"),
    ).toEqual([
      "b6afb4ad0cea526702ffbab82d7e5d32314a69327554e95d1064161d264929c4",
      "a9dadb54ef589b4ca66a6ac18646dab6dc9a96e7142e6ef4fc45fd89542c2dd1",
    ]);
  });
});
