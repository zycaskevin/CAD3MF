import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("dist/caddesk-viewer.html");
const info = await stat(output);
if (!info.isFile() || info.size < 1024) throw new Error("viewer bundle is missing or unexpectedly small");

const html = await readFile(output, "utf8");
if (!html.includes('data-caddesk-viewer="v1"')) throw new Error("viewer marker missing from bundled HTML");
if (!html.includes("<script")) throw new Error("viewer bundle does not contain JavaScript");
if (/src=["']\/(?!\/)/.test(html)) throw new Error("viewer bundle still references an external root-relative script");

console.log(`CADDesk viewer bundle OK: ${info.size} bytes`);
