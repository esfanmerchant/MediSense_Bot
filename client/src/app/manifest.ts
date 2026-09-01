import type { MetadataRoute } from "next";

/**
 * The web app manifest, so MediSense can be installed to a home screen.
 *
 * `start_url` is the login page rather than the landing page, and that is the
 * whole difference between an installed app and a bookmark: somebody who put
 * this on their phone did it to reach their own care, not to read the
 * marketing. The session provider sends them onward to their portal if they are
 * already signed in.
 *
 * Two icon sets, because Android does two different things with them. The plain
 * pair is used as-is; the maskable pair has the mark drawn inside the safe zone,
 * since the launcher crops icons to whatever shape the phone's theme uses and an
 * icon drawn edge to edge loses its arms to a circle.
 *
 * `display: standalone` rather than `fullscreen`: this is a clinical tool used
 * next to other apps — a banking app for the transfer, a camera for the receipt
 * — and swallowing the status bar takes away the clock and the battery from
 * somebody who may be on a ward for a shift.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MediSense — Smart Healthcare Management",
    short_name: "MediSense",
    description:
      "Appointments, records, vitals and billing in one place — for patients, doctors and hospital staff.",
    start_url: "/login",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#00194d",
    theme_color: "#00194d",
    lang: "ur-Latn",
    dir: "ltr",
    categories: ["medical", "health", "productivity"],
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/brand/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // The three things somebody opens the app *for*. Long-pressing the icon on
    // Android, or the dock on iOS, goes straight there.
    shortcuts: [
      {
        name: "Book an appointment",
        short_name: "Book",
        url: "/patient/appointments",
        icons: [{ src: "/brand/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Health assistant",
        short_name: "Assistant",
        url: "/patient/assistant",
        icons: [{ src: "/brand/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "My records",
        short_name: "Records",
        url: "/patient/records",
        icons: [{ src: "/brand/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
