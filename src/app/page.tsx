import Image from "next/image";
import Link from "next/link";
import { HomeStatus } from "@/components/HomeStatus";
import { SectionTitle } from "@/components/ui";

type Module = {
  /** Matches a `<Tabs>` id on the console, so the card deep-links to it. */
  id: string;
  name: string;
  blurb: string;
  capabilities: string[];
  /** The approval queue is the invariant, so it is the one card in red. */
  accent?: boolean;
};

const MODULES: Module[] = [
  {
    id: "requests",
    name: "Requests & approvals",
    blurb:
      "Someone asks for a tool, a named approver decides, and only then is anything provisioned. There is no other route to a grant.",
    capabilities: ["Route to the owner", "Approve or deny", "Time-bound access", "Re-notify"],
    accent: true,
  },
  {
    id: "entitlements",
    name: "Entitlement register",
    blurb:
      "Who holds what, how they came to hold it, and whether the last revoke actually went through at the provider.",
    capabilities: ["Active grants", "Failed revokes", "Import existing access", "Revoke"],
  },
  {
    id: "catalog",
    name: "Tools & subscriptions",
    blurb:
      "Every managed subscription with its owner, seats bought against seats held, and how a grant is carried out.",
    capabilities: ["Seats and spend", "Provisioning method", "Owners", "Archive"],
  },
  {
    id: "reviews",
    name: "Scheduled reviews",
    blurb:
      "Campaigns that put each grant in front of the tool owner on its own cadence, then apply the revokes that were decided.",
    capabilities: ["Open a campaign", "Keep or revoke", "Apply decisions", "Overdue tools"],
  },
  {
    id: "people",
    name: "People & lifecycle",
    blurb:
      "The Google Workspace directory against the register: suspended and dormant accounts still holding access, new accounts, and grants with no account behind them.",
    capabilities: ["Directory", "Suspended", "Dormant", "Offboard"],
  },
  {
    id: "audit",
    name: "Audit trail",
    blurb:
      "Append-only record of every decision, grant, revoke and refusal — including what the provider replied when it said no.",
    capabilities: ["By person", "By tool", "By request", "Provider replies"],
  },
];

type Integration = { id: string; name: string; role: string };

const INTEGRATIONS: Integration[] = [
  {
    id: "workspace",
    name: "Google Workspace Admin",
    role: "Provisioning and the people directory",
  },
  { id: "gmail", name: "Gmail", role: "Approval requests and decisions" },
  {
    id: "slack",
    name: "Slack",
    role: "Channel access, and approvals by direct message",
  },
  { id: "chat", name: "Google Chat", role: "Approval notices in the room" },
];

export default function Home() {
  return (
    <div className="relative min-h-dvh overflow-hidden">
      {/* Brand wash in NDI red, kept faint so the accent stays a highlight. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-52 h-[460px] bg-[radial-gradient(55%_60%_at_50%_50%,rgba(254,1,0,0.10),transparent_70%)]"
      />

      <div className="relative mx-auto max-w-5xl px-6 py-14">
        <header>
          <div className="flex flex-wrap items-center justify-between gap-6">
            {/* The logo PNG has a white background; multiply drops it cleanly. */}
            <Image
              src="/logo.png"
              alt="NDI — New Digital Intelligence"
              width={301}
              height={168}
              priority
              className="h-12 w-auto mix-blend-multiply"
            />
            <span className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-black/60">
              <span className="size-1.5 rounded-full bg-brand" />
              4 apps connected
            </span>
          </div>

          <div className="mt-9 max-w-2xl border-l-4 border-brand pl-5">
            <p className="font-mono text-xs font-medium tracking-[0.2em] text-brand-ink uppercase">
              GP-19
            </p>
            <h1 className="mt-1.5 text-4xl font-semibold tracking-tight sm:text-[2.75rem] sm:leading-[1.1]">
              Access Tools and
              <br />
              Subscription Manager
            </h1>
            <p className="mt-4 text-lg leading-relaxed text-black/55">
              Provision, review and revoke tool access from one register. Every
              request waits for a named approver before anything changes.
            </p>
          </div>
        </header>

        <HomeStatus />

        <section className="mt-14">
          <SectionTitle>Modules</SectionTitle>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.map((module) => (
              <Link
                key={module.id}
                href={`/access?tab=${module.id}`}
                className="group relative overflow-hidden rounded-2xl border border-black/8 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lg"
              >
                {/* Red hairline that fills in on hover. */}
                <span
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-0.5 origin-left scale-x-0 bg-brand transition-transform duration-300 group-hover:scale-x-100"
                />
                <div
                  aria-hidden
                  className={`absolute -top-16 -right-16 size-40 rounded-full ${
                    module.accent ? "bg-brand opacity-[0.08]" : "bg-black opacity-[0.04]"
                  } transition group-hover:opacity-[0.12]`}
                />
                <div className="relative">
                  <div
                    className={`flex size-12 items-center justify-center rounded-xl shadow-sm ${
                      module.accent
                        ? "bg-brand text-white"
                        : "bg-black/[0.05] text-black/70"
                    }`}
                  >
                    <Glyph id={module.id} className="size-6" />
                  </div>

                  <h3 className="mt-4 text-lg font-semibold">{module.name}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-black/50">
                    {module.blurb}
                  </p>

                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {module.capabilities.map((capability) => (
                      <span
                        key={capability}
                        className="rounded-md bg-black/[0.05] px-2 py-0.5 text-[11px] font-medium text-black/60"
                      >
                        {capability}
                      </span>
                    ))}
                  </div>

                  <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium transition group-hover:text-brand-ink">
                    Open module
                    <span className="transition group-hover:translate-x-0.5">→</span>
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-14">
          <SectionTitle>Integrations</SectionTitle>
          <p className="mt-1 text-sm text-black/45">
            All four reach the outside world over one connection, so they
            succeed and fail together.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {INTEGRATIONS.map((integration) => (
              <div
                key={integration.id}
                className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
              >
                <div className="flex size-9 items-center justify-center rounded-lg bg-black/[0.05] text-black/70">
                  <Glyph id={integration.id} className="size-4" />
                </div>
                <p className="mt-2.5 text-sm font-medium">{integration.name}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-black/45">
                  {integration.role}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-black/40">
            Anything else enabled on that connection — Drive, Sheets — is
            reachable by the same client; these four are the ones this app
            depends on.
          </p>
        </section>

        <footer className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-black/10 pt-6 text-sm text-black/45">
          <p>
            Also available as a Claude Code plugin —{" "}
            <code className="rounded bg-black/[0.05] px-1.5 py-0.5 text-xs">
              /access
            </code>{" "}
            follows the same rules this app does, approver and all.
          </p>
          <p className="font-mono text-xs tracking-wider text-black/35">
            NEW DIGITAL INTELLIGENCE
          </p>
        </footer>
      </div>
    </div>
  );
}

/**
 * Line icons drawn inline: no image files, no icon dependency, and they take
 * the tile's colour so the accent card needs no second asset.
 */
function Glyph({ id, className = "" }: { id: string; className?: string }) {
  const paths: Record<string, React.ReactNode> = {
    requests: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="m8.2 12.2 2.6 2.6 5-5.4" />
      </>
    ),
    entitlements: (
      <>
        <circle cx="8" cy="14.5" r="3.8" />
        <path d="M10.9 12 20 3m-3.4 3 2.1 2.1m-4.5.4 2.1 2.1" />
      </>
    ),
    catalog: (
      <>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
      </>
    ),
    reviews: (
      <>
        <rect x="3.5" y="5" width="17" height="15.5" rx="2.4" />
        <path d="M8 3v4m8-4v4M3.5 10h17m-11.4 5.4 1.9 1.9 3.6-3.7" />
      </>
    ),
    people: (
      <>
        <circle cx="9.2" cy="8.4" r="3.4" />
        <path d="M3.6 19.8c.6-3.3 2.8-5 5.6-5s5 1.7 5.6 5" />
        <path d="M16.4 5.6a3.4 3.4 0 0 1 0 5.6m1.2 3.7c1.6.7 2.6 2.2 3 4.3" />
      </>
    ),
    audit: (
      <>
        <path d="M6 3.5h8.5L19 8v12.5H6z" />
        <path d="M14.2 3.6V8H19" />
        <path d="M9 11.5h6.5M9 15h6.5M9 18h3.5" />
      </>
    ),
    workspace: (
      <>
        <path d="M12 3 5 5.9v5.4c0 4 2.9 7.6 7 9.4 4.1-1.8 7-5.4 7-9.4V5.9z" />
        <path d="m9 12 2.2 2.2 4.1-4.4" />
      </>
    ),
    gmail: (
      <>
        <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
        <path d="m3.8 7.6 8.2 5.9 8.2-5.9" />
      </>
    ),
    // Slack's four interlocking bars, reduced to a stroked hash — the real
    // mark is a registered logo and this is a neutral glyph, not a brand use.
    slack: (
      <>
        <path d="M9.4 3.6v9m5.2-9v9M4.6 8.4h9m-9 5.2h9" />
        <circle cx="17.6" cy="17.6" r="2.4" />
      </>
    ),
    chat: (
      <>
        <rect x="3.5" y="4.5" width="17" height="12" rx="2.5" />
        <path d="M8.5 16.5v3.2l4.2-3.2" />
      </>
    ),
  };

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {paths[id]}
    </svg>
  );
}
