/**
 * What the service worker shows when a navigation cannot reach the server.
 *
 * Deliberately plain and deliberately empty of data. The temptation on a page
 * like this is to show the last thing the person was looking at; the reason not
 * to is that a chart with no way of saying how old it is, shown to somebody who
 * is offline, is the most dangerous screen this application could render.
 */
export const metadata = { title: "Offline — MediSense" };

export default function Offline() {
  return (
    <main
      id="main"
      className="grid min-h-screen place-items-center bg-canvas px-6 text-center"
    >
      <div className="max-w-sm">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-sunken text-strong">
          <span className="material-symbols-outlined text-[28px]" aria-hidden>
            cloud_off
          </span>
        </span>
        <h1 className="font-display mt-5 text-2xl font-bold text-strong">
          You are offline
        </h1>
        <p className="mt-2 text-base leading-relaxed text-muted">
          MediSense needs a connection to show your records. Nothing is stored on
          this device, which is why there is nothing to show you here.
        </p>
        <p className="mt-5 text-sm text-faint">
          This page will work again the moment you are back online.
        </p>
      </div>
    </main>
  );
}
