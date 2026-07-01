/** @type {import('next').NextConfig} */
const projectRoot = process.cwd();

const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: projectRoot,
  serverExternalPackages: ["better-sqlite3"],
  transpilePackages: ["@tutti-os/ui-system"],
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
