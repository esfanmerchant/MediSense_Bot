"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Loading } from "@/components/ui";
import { homePathFor, useSession } from "@/lib/session";

/** Sends each role to its own dashboard, or to sign-in. */
export default function Home() {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? homePathFor(user.role) : "/login");
  }, [user, loading, router]);

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-16">
      <Loading label="Taking you to your dashboard" />
    </main>
  );
}
