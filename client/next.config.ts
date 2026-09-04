import type { NextConfig } from "next";

/**
 * The origin part of a URL, or nothing if it is unset or unparseable.
 *
 * Used to turn the configured API and storage URLs into CSP sources. Taking the
 * origin rather than the whole string matters: a policy naming a path is not a
 * policy a browser will match.
 */
function originOf(url: string | undefined): string[] {
  if (!url) return [];
  try {
    return [new URL(url).origin];
  } catch {
    return [];
  }
}

const api = originOf(process.env.NEXT_PUBLIC_API_URL);
const supabase = originOf(process.env.NEXT_PUBLIC_SUPABASE_URL);

/**
 * `'unsafe-eval'`, and only while developing.
 *
 * React's development build uses `eval()` for its debugging machinery —
 * reconstructing a callstack that came from another environment, chiefly — and
 * refuses to start without it, which is what a CSP written for production does
 * to `next dev`: a console full of "eval() is not supported in this
 * environment" and an error overlay that cannot render.
 *
 * React's own message is the justification for scoping it this narrowly: *"React
 * will never use eval() in production mode."* So the production policy keeps
 * `eval` denied, which is the half that matters — it is the primitive that turns
 * an injected string into running code.
 *
 * Keyed on NODE_ENV, which Next sets itself: `development` for `next dev`,
 * `production` for `next build`. Nothing here can loosen a deployed policy,
 * because a deployment is built in production mode by definition.
 */
const developing = process.env.NODE_ENV !== "production";

/**
 * What the Google Maps JavaScript API needs, per host and per directive.
 *
 * Grouped and named rather than scattered through the policy, because these are
 * not this application's own origins — they are one feature's dependency, and
 * if the clinic map is ever dropped this is the block to delete.
 *
 * The wildcards are not laziness. Maps fetches its tiles from rotating
 * `khms*.googleapis.com` hosts and its Street View imagery from `*.ggpht.com`,
 * neither of which has a fixed name to list. Naming only `maps.googleapis.com`
 * loads the script and then leaves a blank grey square where the map should be —
 * a failure that shows up on the patient's appointment page and nowhere in any
 * test.
 */
const maps = {
  script: ["https://maps.googleapis.com"],
  img: ["https://maps.gstatic.com", "https://*.googleapis.com", "https://*.ggpht.com"],
  connect: ["https://maps.googleapis.com", "https://*.googleapis.com"],
};

/**
 * Content-Security-Policy for the pages this app serves.
 *
 * Built from the configured origins rather than written as a literal, so a
 * deployment that moves its API does not silently end up with a policy that
 * blocks its own requests — the classic way a CSP gets switched off in a hurry
 * and never switched back on.
 *
 * **What this does and does not buy.** `frame-ancestors`, `base-uri` and
 * `form-action` are absolute: this app cannot be framed for clickjacking, a
 * `<base>` tag cannot redirect its relative URLs, and a form cannot post
 * anywhere but here. `script-src` and `connect-src` pin *where* code and
 * requests may come from, so an injected `<script src=...>` pointing at another
 * host is dead.
 *
 * `'unsafe-inline'` on scripts is a real limitation and worth stating plainly:
 * Next's App Router streams hydration data through inline `<script>` tags, so a
 * policy without it renders a blank page. Removing it needs per-request nonces
 * through middleware, which is a change to how every page renders — worth doing,
 * and not worth doing the night before a deadline. Until then this policy does
 * not stop an injected *inline* script, and the defence against that stays what
 * it already is: React escaping everything it renders, and no `dangerouslySetInnerHTML`
 * anywhere in this codebase.
 */
const csp = [
  "default-src 'self'",
  // Google Maps draws the clinic locations; it loads its own further scripts.
  `script-src 'self' 'unsafe-inline' ${developing ? "'unsafe-eval' " : ""}${maps.script.join(" ")}`,
  // Tailwind and the Material Symbols stylesheet; inline styles come from the
  // framework, from element-level style attributes, and from Maps, which
  // injects its own.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  // `blob:` is the avatar cropper previewing a file before upload; `data:` is
  // inlined icons. Supabase serves every document and avatar through a signed
  // URL on its own origin.
  `img-src 'self' data: blob: ${[...supabase, ...maps.img].join(" ")}`,
  `connect-src 'self' ${[...api, ...supabase, ...maps.connect].join(" ")}`,
  // The service worker, which delivers push notifications offline.
  "worker-src 'self'",
  "manifest-src 'self'",
  // Nothing here is embedded, and nothing embeds this.
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Only once the API is actually reachable over https. Sent unconditionally it
  // would rewrite a local `http://…:4000` API URL to https and break every
  // request against a server that is not listening for TLS — a CSP that breaks
  // development is a CSP somebody deletes rather than fixes.
  ...(api.every((origin) => origin.startsWith("https://")) ? ["upgrade-insecure-requests"] : []),
]
  .map((directive) => directive.replace(/\s+/g, " ").trim())
  .join("; ");

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

  async headers() {
    return [
      {
        // Every route, including the service worker and the manifest.
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Nothing in this application asks for any of these. Saying so means
          // an injected iframe cannot ask on its behalf.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          // Belt and braces with `frame-ancestors` above, for browsers that
          // only understand the older header.
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
