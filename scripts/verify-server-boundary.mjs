import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

// Build a deliberately invalid, isolated client import. Never edit the real UI.
const root = process.cwd();
await mkdir(path.join(root, ".verification"), { recursive: true });
const fixture = await mkdtemp(
  path.join(root, ".verification", "server-boundary-"),
);
await mkdir(path.join(fixture, "app"));
const modulePath = path
  .relative(
    path.join(fixture, "app"),
    path.join(root, "src/lib/supabase/admin-client"),
  )
  .split(path.sep)
  .join("/");
await writeFile(
  path.join(fixture, "package.json"),
  JSON.stringify({
    name: "relay-boundary-check",
    private: true,
    type: "module",
  }),
);
await writeFile(
  path.join(fixture, "tsconfig.json"),
  JSON.stringify({
    extends: "../../tsconfig.json",
    include: ["app/**/*.tsx", ".next/types/**/*.ts"],
  }),
);
await writeFile(
  path.join(fixture, "next.config.mjs"),
  `export default { turbopack: { root: ${JSON.stringify(root)} } };`,
);
await writeFile(
  path.join(fixture, "app/layout.tsx"),
  "export default function Layout({children}:{children: React.ReactNode}) { return <html><body>{children}</body></html>; }",
);
await writeFile(
  path.join(fixture, "app/page.tsx"),
  `"use client";\nimport { createAdminSupabaseClient } from ${JSON.stringify(modulePath)};\nexport default function Page() { return <button onClick={() => createAdminSupabaseClient()}>Boundary check</button>; }`,
);

const result = spawnSync(
  process.execPath,
  [path.join(root, "node_modules/next/dist/bin/next"), "build"],
  {
    cwd: fixture,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  },
);
if (result.error) throw result.error;
const output = `${result.stdout}\n${result.stderr}`;
await writeFile(
  path.join(root, ".verification/server-boundary-result.log"),
  output,
);
assert.notEqual(
  result.status,
  0,
  "Privileged module unexpectedly compiled into a client component",
);
assert.match(output, /server-only/);
assert.match(
  output,
  /Client Component|client component|client-only|client-side/i,
);
console.log(
  "PASS: Next.js rejected a client component importing the actual privileged Supabase module.",
);
