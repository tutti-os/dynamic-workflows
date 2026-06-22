/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  transpilePackages: ["@tutti-os/ui-system"],
};

export default nextConfig;
