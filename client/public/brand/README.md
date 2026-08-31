# Brand assets

Drop the logo artwork here:

| File | What it is |
|---|---|
| `MediSense_logo.png` | The full lockup — cross, pulse, circuit nodes, and the wordmark — on a transparent or white background |
| `nayapay-qr.png` | The NayaPay payment QR, shown to a patient beside the account number |

## `nayapay-qr.png`

This one **is** used, by `components/PayInvoice.tsx`, and it is the only asset
here the application actually looks for. Save the QR image from the NayaPay app
under exactly that name.

It is a convenience, not the payment: the account number is printed beside it
and is what actually carries a transfer. If the file is missing the picture is
simply not rendered — no broken-image icon, because a broken image on a screen
where somebody is about to send money is worse than no picture at all.

**Nothing in the application depends on this file today.** The mark and the
wordmark are drawn as vectors in `src/components/brand/Logo.tsx`, which is why
they stay sharp on a 4K display, recolour for the dark theme, and cost no
request. The PNG is here for the places a raster is the only option — an email
header, a slide, a favicon export.

If you add the PNG and want it used on screen, say so: it is a one-line change
in `Logo.tsx`, and the trade is sharpness and theme-awareness for pixel-exact
fidelity to the source file.
