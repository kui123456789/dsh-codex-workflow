// Shared helpers for the release check (and its unit tests), kept free of
// Node-core runtime deps so both the script and the test suite can import it.
import { gunzipSync } from "node:zlib";

/** List member names of a tar.gz buffer (ustar format, gzip compressed). */
export function parseTarGzMembers(buffer) {
  const raw = gunzipSync(buffer);
  const names = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const nameEnd = header.indexOf(0);
    if (nameEnd <= 0) break;
    const name = header.subarray(0, nameEnd).toString("latin1");
    const sizeField = header.subarray(124, 136).toString("latin1").replace(/\0/g, "").trim();
    const size = parseInt(sizeField, 8) || 0;
    if (name) names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

/** package.json `files` whitelist enforced by the pack audit. */
export const RELEASE_ALLOWED_FILES = new Set([
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "cordis.patch.yml",
]);

export const RELEASE_ALLOWED_PREFIXES = ["lib/", "scripts/"];

export const RELEASE_FORBIDDEN = [
  /(^|\/)test\//,
  /\.test\./,
  /coord\.sqlite/,
  /(^|\/)\.dsh(\/|$)/,
  /credential/i,
  /secret/i,
  /\.tgz$/,
  /\.tmp$/,
  /\.codex-pack-review/,
  /doctor-write-probe/,
];
