import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist"), destination = join(output, "codex-workflow");
if (resolve(destination) !== join(root, "dist", "codex-workflow")) throw new Error("Package target escaped its output directory");
await mkdir(output, { recursive: true });
await rm(destination, { recursive: true, force: true });
await mkdir(destination);
for (const name of ["SKILL.md", "agents", "references", "LICENSE"]) await cp(join(root, name), join(destination, name), { recursive: true });
await mkdir(join(destination, "scripts"));
await cp(join(root, "scripts", "workflow.mjs"), join(destination, "scripts", "workflow.mjs"));
const files = [];
async function walk(directory, prefix = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error("Skill package must not contain symbolic links");
    if (entry.isDirectory()) await walk(join(directory, entry.name), prefix + entry.name + "/");
    else files.push({ name: "codex-workflow/" + prefix + entry.name, data: await readFile(join(directory, entry.name)) });
  }
}
await walk(destination);
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
const local = [], central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(file.name), compressed = deflateRawSync(file.data), crc = crc32(file.data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
  header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(name.length, 26);
  local.push(header, name, compressed);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10);
  directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(file.data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
  central.push(directory, name); offset += header.length + name.length + compressed.length;
}
const end = Buffer.alloc(22), listing = Buffer.concat(central);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(listing.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, listing, end]);
await writeFile(join(output, "codex-workflow.zip"), zip);
const manifest = { files: files.map((file) => ({ path: file.name, sha256: createHash("sha256").update(file.data).digest("hex") })), zipSha256: createHash("sha256").update(zip).digest("hex") };
await writeFile(join(output, "artifacts.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ directory: destination, zip: join(output, "codex-workflow.zip"), ...manifest }));
