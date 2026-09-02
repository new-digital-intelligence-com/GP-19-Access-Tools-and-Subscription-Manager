/**
 * The domain model, shared by the API routes, the UI and the agent's native
 * tools. Deliberately small and serialisable: every record round-trips through
 * a JSON file in `.data/`, so nothing here may hold a class instance or a Date.
 *
 * Timestamps are ISO 8601 strings, always UTC.
 */

/** How an entitlement is actually granted and revoked in Google Workspace. */
export type ProvisioningMethod =
  /** Membership of a Google group gates the app. Grant = add to group. */
  | "google-group"
  /** A paid Workspace SKU. Grant = assign licence. */
  | "google-license"
  /** Membership of a Slack channel. Grant = invite. */
  | "slack-channel"
  /** No API path — a human does it in the vendor's own admin console. */
  | "manual";

/** A managed tool or SaaS subscription. The catalogue is the app's own state. */
export type Tool = {
  id: string;
  name: string;
  vendor: string;
  category: string;
  /** Work email of the person accountable for this subscription. */
  ownerEmail: string;
  /** Cost of one seat per month, in `Settings.currency`. */
  costPerSeat: number;
  /** Seats paid for. Compared against active entitlements to find waste. */
  seatsPurchased: number;
  provisioning: ProvisioningMethod;
  /** Google group address, for `google-group`. */
  groupEmail?: string;
  /** Licensing API productId / skuId, for `google-license`. */
  productId?: string;
  skuId?: string;
  /** Slack channel id (`C…`), for `slack-channel`. Not the channel name. */
  slackChannelId?: string;
  /** Roles or plan tiers a requester can ask for. */
  roles: string[];
  /** Days between scheduled entitlement reviews. 0 disables the schedule. */
  reviewCadenceDays: number;
  /** Handling for data-sensitive tools: forces a named approver. */
  sensitive: boolean;
  notes?: string;
  createdAt: string;
  archivedAt?: string;
};

/**
 * A person, as Google Workspace knows them.
 *
 * Note what is absent: there is no employment status, hire date or termination
 * date, because no HR system is connected and Workspace does not hold them.
 * `accountState` describes the *account*, not the person — a suspended account
 * is a signal worth reviewing, never proof that someone left.
 */
export type Person = {
  /** Workspace user id, falling back to the primary email. */
  id: string;
  workEmail: string;
  displayName: string;
  jobTitle?: string;
  department?: string;
  managerEmail?: string;
  orgUnitPath?: string;
  isAdmin?: boolean;
  accountState: "active" | "suspended" | "archived";
  suspensionReason?: string;
  /** When the Workspace account was created. */
  createdAt?: string;
  /** Absent means never signed in — Google returns the epoch, which we drop. */
  lastLoginAt?: string;
  /** When this record was last read from the directory. */
  syncedAt?: string;
};

export type EntitlementStatus = "active" | "revoked" | "pending-revoke";

/** One person's grant of one tool. The register the reviews run against. */
export type Entitlement = {
  id: string;
  personEmail: string;
  personName?: string;
  toolId: string;
  role?: string;
  status: EntitlementStatus;
  /** How it came to exist. `imported` means nobody in this app granted it. */
  source: "request" | "lifecycle" | "imported" | "manual";
  grantedAt: string;
  grantedBy: string;
  /** Set when the grant is time-bound. Reviews surface these as they near. */
  expiresAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  /** The access request this grant came from, when there was one. */
  requestId?: string;
  lastReviewedAt?: string;
  lastReviewDecision?: "keep" | "revoke";
  /** What the provider actually returned, kept for the audit trail. */
  provisionNote?: string;
};

export type RequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "provisioned"
  | "failed"
  | "cancelled";

/**
 * An access request. Nothing in this app provisions without one of these
 * reaching `approved` by a human decision — that is the whole point of the
 * human-in-the-loop rule.
 */
export type AccessRequest = {
  id: string;
  requesterEmail: string;
  requesterName?: string;
  toolId: string;
  role?: string;
  justification: string;
  /** Requested end date for time-bound access. */
  expiresAt?: string;
  status: RequestStatus;
  createdAt: string;
  /** Who the request was routed to. Always a person, never the app. */
  approverEmail?: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  /** Result of the provisioning attempt made after approval. */
  provisionResult?: { ok: boolean; detail: string; at: string };
  entitlementId?: string;
  /** Where the approver was told about it. */
  notifications?: { channel: "email" | "chat" | "slack"; at: string; detail: string }[];
};

export type ReviewDecision = "keep" | "revoke" | "pending";

export type ReviewItem = {
  entitlementId: string;
  personEmail: string;
  toolId: string;
  decision: ReviewDecision;
  reviewer?: string;
  decidedAt?: string;
  note?: string;
  /** Set once a `revoke` decision has actually been carried out. */
  appliedAt?: string;
};

/** A scheduled entitlement review over a scope of tools. */
export type ReviewCampaign = {
  id: string;
  name: string;
  /** Tool ids in scope. Empty means every non-archived tool. */
  toolIds: string[];
  createdAt: string;
  createdBy: string;
  dueAt: string;
  status: "open" | "closed";
  closedAt?: string;
  items: ReviewItem[];
};

/** Append-only. Never edited, never deleted — that is what makes it a trail. */
export type AuditEvent = {
  id: string;
  at: string;
  /** The human or system that caused it. "agent" is never an approver. */
  actor: string;
  action: string;
  /** What it happened to: an email, a tool id, a request id. */
  subject: string;
  result: "ok" | "error" | "info";
  detail: string;
  requestId?: string;
  toolId?: string;
  personEmail?: string;
};

export type Settings = {
  /** The Google Workspace primary domain. Used to sanity-check emails. */
  domain: string;
  /** Fallback approvers when a tool has no owner. Never empty in practice. */
  approvers: string[];
  /** Default days between reviews for a tool that does not set its own. */
  defaultReviewCadenceDays: number;
  /** Where approval requests go. Any combination may be on. */
  notify: { email: boolean; chat: boolean; slack: boolean };
  /** Google Chat space for approvals, as the connector's "room" value. */
  chatRoom?: string;
  /**
   * Slack channel id used when an approver has no Slack account.
   *
   * The first choice is always a DM to the approver — an approval waiting in a
   * shared channel is everybody's job and therefore nobody's. This is the
   * fallback so the request is still seen by someone.
   */
  slackChannel?: string;
  /** Currency label for cost figures. Display only; no conversion is done. */
  currency: string;
  /** Days an account may sit suspended while still holding access. */
  offboardingSlaDays: number;
  /**
   * Google Sheet the register is published to, so Claude can read it.
   *
   * A published copy, never the source of truth — nothing reads back from it.
   */
  registerSheetId?: string;
  /** Tone for drafted notifications and decision notes. */
  voice: string;
};

/** Connectivity of the one upstream this app has. */
export type ZapierStatus = {
  state: "ready" | "unconfigured" | "unavailable";
  detail?: string;
  /** Tool count reported by the server, by app prefix. */
  apps?: { app: string; tools: number }[];
};
