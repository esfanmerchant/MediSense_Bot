"use client";

/**
 * A doctor's clinic on a map.
 *
 * **Everything here degrades to nothing.** The map is a convenience on top of a
 * written address, never the thing that carries it: no key configured, no
 * coordinates on the record, a blocked script, an offline browser — each ends
 * with this component rendering `null` and the address above it still telling a
 * patient where to go. A clinic finder that shows a grey box when Google is
 * unreachable is worse than one that shows an address.
 *
 * The script is loaded once per page rather than once per map. Google's loader
 * appends a `<script>` and defines a global, so a directory of six doctors that
 * each asked for their own copy would race six identical downloads and then
 * fight over the same global.
 */

import { useEffect, useRef, useState } from "react";

import { useTr } from "@/lib/lang";

const KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

/**
 * What this component actually needs out of the Maps API.
 *
 * Narrow on purpose: the global is `any`-shaped and enormous, and naming only
 * the two constructors keeps a typo in an option bag from compiling.
 */
interface MapsApi {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => unknown;
  Marker: new (options: Record<string, unknown>) => unknown;
}

declare global {
  interface Window {
    google?: {
      maps?: {
        /** Present the moment the bootstrap runs; the classes are not. */
        importLibrary?: (name: string) => Promise<Record<string, unknown>>;
      };
    };
  }
}

/**
 * The one load, shared by every map on the page.
 *
 * Module scope rather than a hook, deliberately: the thing being deduplicated
 * is a `<script>` tag in the document, which outlives any component that asked
 * for it, so the memo of it has to live at the same scope the tag does.
 */
let mapsApi: Promise<MapsApi | null> | null = null;

const SRC_PREFIX = "https://maps.googleapis.com/maps/api/js";

/** Put the bootstrap in the page, or reuse the one already there. */
function injectBootstrap(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Fast Refresh replaces this module while the tag it appended survives, so
    // without this a saved edit adds a second copy and Google complains that
    // the API was included twice.
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src^="${SRC_PREFIX}"]`,
    );
    if (existing) {
      if (window.google?.maps?.importLibrary) return resolve(true);
      existing.addEventListener("load", () => resolve(true), { once: true });
      existing.addEventListener("error", () => resolve(false), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = `${SRC_PREFIX}?key=${encodeURIComponent(KEY ?? "")}&loading=async&v=weekly`;
    script.async = true;
    script.onload = () => resolve(true);
    // Blocked by an extension, offline, a refused key — all the same answer.
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

/**
 * The Maps classes, once they genuinely exist.
 *
 * **`loading=async` is why this is not just an onload handler.** In that mode
 * the script's load event fires as soon as the *bootstrap* has run, and the
 * bootstrap defines exactly one thing: `google.maps.importLibrary`. The classes
 * are fetched separately, on request. So `window.google.maps` being truthy
 * after onload means nothing about `google.maps.Map` existing — which is how
 * this came to throw "Map is not a constructor" the moment somebody panned a
 * map, with the page's own error overlay on top of a booking flow.
 *
 * Awaiting `importLibrary` is the documented way to ask for them, and it is
 * also the answer to the race: two maps mounting together share this promise
 * and both wait for the same fetch.
 */
function loadMaps(): Promise<MapsApi | null> {
  if (mapsApi) return mapsApi;

  const attempt = (async (): Promise<MapsApi | null> => {
    if (!KEY) return null;
    try {
      if (!window.google?.maps?.importLibrary) {
        if (!(await injectBootstrap())) return null;
      }
      const importLibrary = window.google?.maps?.importLibrary;
      if (!importLibrary) return null;

      const [maps, marker] = await Promise.all([
        importLibrary("maps"),
        importLibrary("marker"),
      ]);
      const Map = maps.Map as MapsApi["Map"] | undefined;
      const Marker = marker.Marker as MapsApi["Marker"] | undefined;
      // Both, or neither: a map with no pin on it is not what was asked for.
      return Map && Marker ? { Map, Marker } : null;
    } catch {
      return null;
    }
  })();

  mapsApi = attempt;
  // A failed load is not cached. The usual cause is a network that was down for
  // a moment, and holding the failure would mean the map never returns for as
  // long as the tab is open.
  void attempt.then((api) => {
    if (api === null && mapsApi === attempt) mapsApi = null;
  });
  return attempt;
}

export function ClinicMap({
  latitude,
  longitude,
  label,
  className,
}: {
  latitude: number | null;
  longitude: number | null;
  /** The clinic's name, for the marker's tooltip. */
  label: string;
  className?: string;
}) {
  const tr = useTr();
  const holder = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);

  const hasPin = latitude !== null && longitude !== null;

  useEffect(() => {
    if (!hasPin) return;

    let cancelled = false;

    void loadMaps().then((api) => {
      if (cancelled) return;

      if (!api || !holder.current) {
        setReady(false);
        return;
      }

      // Wrapped, and this is the point of the whole component. Anything thrown
      // here happens inside somebody's booking, and an exception escaping an
      // effect takes the page down with it — which is what turned a panned map
      // into a full-screen error over a half-finished appointment. A map that
      // cannot be drawn is a map that is not drawn.
      try {
        const position = { lat: latitude, lng: longitude };
        const map = new api.Map(holder.current, {
          center: position,
          zoom: 15,
          // A clinic finder needs the street it is on, not the world's borders.
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });
        new api.Marker({ map, position, title: label });
        setReady(true);
      } catch {
        setReady(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [hasPin, latitude, longitude, label]);

  // No pin on the record, or the map could not load. Either way the address
  // above has already said where this is.
  if (!hasPin || ready === false) return null;

  return (
    <div className={className}>
      <div
        ref={holder}
        role="img"
        aria-label={tr(`Map showing ${label}`, `${label} ka naqsha`)}
        className="h-44 w-full overflow-hidden rounded-xl border border-line bg-sunken"
      />
    </div>
  );
}
