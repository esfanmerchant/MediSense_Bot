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
 * The one in-flight load, shared by every map on the page.
 *
 * Module scope rather than a hook, deliberately: the thing being deduplicated
 * is a `<script>` tag in the document, which outlives any component that asked
 * for it, so the memo of it has to live at the same scope the tag does.
 */
let mapsScript: Promise<boolean> | null = null;

declare global {
  interface Window {
    google?: {
      maps?: {
        Map: new (element: HTMLElement, options: Record<string, unknown>) => unknown;
        Marker: new (options: Record<string, unknown>) => unknown;
      };
    };
  }
}

function loadMaps(): Promise<boolean> {
  if (mapsScript) return mapsScript;

  mapsScript = new Promise<boolean>((resolve) => {
    if (!KEY) return resolve(false);
    if (window.google?.maps) return resolve(true);

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(KEY)}&loading=async`;
    script.async = true;
    script.onload = () => resolve(Boolean(window.google?.maps));
    // Blocked by an extension, offline, a refused key — all the same answer.
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });

  return mapsScript;
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
    void loadMaps().then((ok) => {
      if (cancelled) return;
      setReady(ok);
      if (!ok || !holder.current || !window.google?.maps) return;

      const position = { lat: latitude, lng: longitude };
      const map = new window.google.maps.Map(holder.current, {
        center: position,
        zoom: 15,
        // A clinic finder needs the street it is on, not the world's borders.
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
      });
      new window.google.maps.Marker({ map, position, title: label });
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
