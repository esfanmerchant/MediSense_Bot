import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Emit `.next/standalone`: a server plus only the node_modules the traced
   * routes actually reach.
   *
   * This is what makes the container image small — without it a production
   * image has to carry the whole dependency tree, devDependencies excluded but
   * everything else present, to run `next start`. It changes nothing about
   * local development: `next dev` and `next start` behave exactly as before,
   * and the folder is simply also written.
   */
  output: "standalone",
};

export default nextConfig;
