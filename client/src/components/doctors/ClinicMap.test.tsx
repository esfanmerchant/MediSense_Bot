/**
 * The map is allowed to fail. It is not allowed to take the page with it.
 *
 * Two things are pinned here, and both are the bug that was reported:
 *
 *   - the classes are awaited through `importLibrary`, never read off
 *     `window.google.maps` after the script's load event. Under `loading=async`
 *     that event fires when the *bootstrap* has run, and the bootstrap defines
 *     `importLibrary` and nothing else — so `google.maps.Map` is undefined, and
 *     `new` on it threw "Map is not a constructor" over somebody's booking.
 *
 *   - anything thrown while building the map is contained. An exception escaping
 *     an effect unmounts the tree above it, which is how a panned map became a
 *     full-screen error on a half-finished appointment.
 *
 * The module caches its load at module scope, so each test imports it fresh.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-key";

/** A fresh copy of the component, with the env var it reads at import time. */
async function freshClinicMap() {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", KEY);
  return (await import("@/components/doctors/ClinicMap")).ClinicMap;
}

/** Stands in for the bootstrap Google injects, one library at a time. */
function stubGoogle(importLibrary: (name: string) => Promise<Record<string, unknown>>) {
  Object.defineProperty(window, "google", {
    value: { maps: { importLibrary } },
    configurable: true,
    writable: true,
  });
}

const MapCtor = vi.fn();
const MarkerCtor = vi.fn();

function workingLibraries() {
  return vi.fn(async (name: string) =>
    name === "maps" ? { Map: MapCtor } : { Marker: MarkerCtor },
  );
}

beforeEach(() => {
  MapCtor.mockClear();
  MarkerCtor.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(window, "google");
});

describe("drawing a clinic", () => {
  it("asks for the classes rather than reading them off the global", async () => {
    const importLibrary = workingLibraries();
    stubGoogle(importLibrary);
    const ClinicMap = await freshClinicMap();

    render(<ClinicMap latitude={24.8607} longitude={67.0011} label="Indus Hospital" />);

    await waitFor(() => expect(MapCtor).toHaveBeenCalledOnce());
    // Both libraries, by name. Reading `google.maps.Map` directly is the bug.
    expect(importLibrary).toHaveBeenCalledWith("maps");
    expect(importLibrary).toHaveBeenCalledWith("marker");

    expect(MarkerCtor).toHaveBeenCalledOnce();
    expect(MarkerCtor.mock.calls[0][0]).toMatchObject({
      position: { lat: 24.8607, lng: 67.0011 },
      title: "Indus Hospital",
    });
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("draws nothing at all when the record has no pin", async () => {
    stubGoogle(workingLibraries());
    const ClinicMap = await freshClinicMap();

    const { container } = render(
      <ClinicMap latitude={null} longitude={null} label="Indus Hospital" />,
    );

    expect(container).toBeEmptyDOMElement();
    // Never asked, so a doctor without coordinates costs no request.
    expect(MapCtor).not.toHaveBeenCalled();
  });
});

describe("when Google will not cooperate", () => {
  it("disappears rather than throwing when a class is missing", async () => {
    // Exactly the reported failure: the bootstrap ran, the library resolved,
    // and `Map` is not in it.
    stubGoogle(vi.fn(async () => ({})));
    const ClinicMap = await freshClinicMap();

    const { container } = render(
      <ClinicMap latitude={24.86} longitude={67.0} label="Indus Hospital" />,
    );

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(MapCtor).not.toHaveBeenCalled();
  });

  it("disappears rather than throwing when the constructor itself fails", async () => {
    stubGoogle(workingLibraries());
    MapCtor.mockImplementationOnce(() => {
      throw new TypeError("Map is not a constructor");
    });
    const ClinicMap = await freshClinicMap();

    const { container } = render(
      <ClinicMap latitude={24.86} longitude={67.0} label="Indus Hospital" />,
    );

    // The whole point. This threw out of an effect before, and React took the
    // booking flow down with it.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("disappears rather than throwing when importLibrary rejects", async () => {
    stubGoogle(vi.fn(async () => Promise.reject(new Error("network"))));
    const ClinicMap = await freshClinicMap();

    const { container } = render(
      <ClinicMap latitude={24.86} longitude={67.0} label="Indus Hospital" />,
    );

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
