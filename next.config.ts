import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

// Phones/laptops on the same network open the dev server through this
// computer's LAN address. Next.js blocks its development scripts for any
// other address, so allow every IPv4 address this computer currently has.
// The list is read when the server starts: restart after changing networks.
const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((entry) => entry?.family === "IPv4" && !entry.internal)
  .map((entry) => entry!.address);

const nextConfig: NextConfig = {
  allowedDevOrigins: lanAddresses,
  serverExternalPackages: ["@google/genai"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
