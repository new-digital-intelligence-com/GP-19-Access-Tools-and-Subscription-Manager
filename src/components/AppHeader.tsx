import Image from "next/image";
import Link from "next/link";

/**
 * Header for the console.
 *
 * The product is one page, so the crumb goes home rather than sideways, and
 * the `right` slot carries whatever the page knows about the acting user —
 * an approval attributed to the wrong person is worse than an ugly header.
 */
export function AppHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-black/10 pb-4">
        <Link href="/" className="flex items-center gap-3">
          {/* The logo PNG has a white background; multiply drops it cleanly. */}
          <Image
            src="/logo.png"
            alt="NDI — New Digital Intelligence"
            width={301}
            height={168}
            priority
            className="h-7 w-auto mix-blend-multiply"
          />
          <span className="hidden font-mono text-[11px] tracking-[0.18em] text-black/35 uppercase sm:inline">
            GP-19
          </span>
        </Link>
        {right}
      </div>

      <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href="/"
            className="text-sm text-black/45 transition hover:text-brand-ink"
          >
            ← Overview
          </Link>
          <h1 className="mt-1 border-l-4 border-brand pl-3 text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1.5 pl-3.5 text-sm text-black/50">{subtitle}</p>
          )}
        </div>
      </div>
    </header>
  );
}
