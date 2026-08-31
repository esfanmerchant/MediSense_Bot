"use client";

/**
 * The terms and community guidelines, as the server states them.
 *
 * **Fetched, never written here.** Consent only means something if the system
 * can say what was agreed to, and a document that lives in a React component
 * cannot be quoted back six months later. The API owns the text and its
 * version; this renders what it returns.
 *
 * `TermsDialog` is what somebody reads *before* ticking the box on the
 * registration form. Making them leave the half-filled form to read it is how a
 * consent screen becomes something people click through — so it opens over the
 * form and closes back onto it.
 */

import { useEffect, useState } from "react";

import { Dialog } from "@/components/overlays";
import { Button, ErrorState } from "@/components/ui";
import { apiRequest } from "@/lib/api";
import { useTr } from "@/lib/lang";

export interface TermsDocument {
  version: string;
  sections: Array<{ heading: string; body: string[] }>;
}

/** One shared fetch: the dialog and the page ask for the same document. */
let cached: Promise<TermsDocument> | null = null;

function loadTerms(): Promise<TermsDocument> {
  cached ??= apiRequest<TermsDocument>("/auth/terms");
  return cached;
}

export function useTerms() {
  const [terms, setTerms] = useState<TermsDocument | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadTerms()
      .then((document) => {
        if (!cancelled) setTerms(document);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { terms, failed };
}

export function TermsBody({ terms }: { terms: TermsDocument }) {
  const tr = useTr();
  return (
    <div className="space-y-7">
      {terms.sections.map((section) => (
        <section key={section.heading}>
          <h3 className="font-display text-lg font-bold text-strong">{section.heading}</h3>
          <div className="mt-2 space-y-2.5">
            {section.body.map((paragraph, index) => (
              <p key={index} className="text-[15px] leading-relaxed text-muted">
                {paragraph}
              </p>
            ))}
          </div>
        </section>
      ))}
      <p className="border-t border-line pt-4 text-xs text-faint">
        {tr(`Version ${terms.version}`, `Version ${terms.version}`)}
      </p>
    </div>
  );
}

export function TermsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tr = useTr();
  const { terms, failed } = useTerms();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      icon="gavel"
      title={tr("Terms and community guidelines", "Shara-it aur community guidelines")}
      description={tr(
        "What MediSense does, what it does not, and what we ask of you.",
        "MediSense kya karta hai, kya nahi, aur aap se kya chahta hai.",
      )}
      footer={
        <Button onClick={onClose}>{tr("Done", "Theek hai")}</Button>
      }
    >
      {failed && (
        <ErrorState
          message={tr(
            "The terms could not be loaded. Please try again.",
            "Shara-it load nahi ho sakeen. Dobara koshish karein.",
          )}
        />
      )}
      {terms && <TermsBody terms={terms} />}
      {!terms && !failed && (
        <p className="text-sm text-muted">{tr("Loading…", "Load ho raha hai…")}</p>
      )}
    </Dialog>
  );
}
