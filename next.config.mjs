/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@tutti-os/agent-acp-kit", "better-sqlite3"],
  transpilePackages: ["@tutti-os/ui-system"],
};

export default nextConfig;
