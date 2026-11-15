import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

// Read secret values only in memory for comparison; never print them or their hashes.
const values = new Set();
const names = [
  "SUPABASE_SECRET_KEY",
  "GEMINI_API_KEY",
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
];
for (const name of names) if (process.env[name]) values.add(process.env[name]);
for (const file of [".env", ".env.local"]) {
  try {
    const env = parseEnv(await readFile(file, "utf8"));
    for (const name of names) if (env[name]) values.add(env[name]);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const directory = ".next/static";
const files = await readdir(directory, {
  recursive: true,
  withFileTypes: true,
});
let scanned = 0;
for (const file of files) {
  if (!file.isFile()) continue;
  const content = await readFile(path.join(file.parentPath, file.name));
  assert.ok(
    !content.includes(Buffer.from("SUPABASE_SECRET_KEY")),
    "Privileged environment reference found in browser assets",
  );
  for (const value of values) {
    assert.ok(
      !content.includes(Buffer.from(value)),
      "A configured secret was found in browser assets",
    );
  }
  scanned++;
}
assert.ok(
  scanned > 0,
  "No browser assets found; run the production build first",
);
console.log(
  `PASS: checked ${scanned} browser assets; no privileged variable reference or configured secret was found.`,
);
