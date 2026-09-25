import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(root, "src", "client.js");
const target = resolve(root, "lib", "client.js");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, await readFile(source));
console.log("copied client bundle -> lib/client.js");
