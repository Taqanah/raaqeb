/**
 * The domain registration (CONTEXT.md "Domain registration"): what Raaqeb
 * knows about the registration of the domain an HTTP, TCP or DNS monitor's
 * host belongs to. One per monitor with the domain expiry option on,
 * replaced whole at each read; no history.
 */

export interface DomainRegistration {
  /** The registered domain the registry answered for, in lower case; absent when no registry named one. */
  readonly domain: string | undefined;
  /** UTC milliseconds; absent when the registry publishes no expiry date Raaqeb can read, which never warns. */
  readonly expiresAt: number | undefined;
  readonly monitorId: string;
  /** UTC milliseconds of the read that answered this. */
  readonly readAt: number;
  /** Whether the warning went for this expiry date; a new date, a renewal, starts over. */
  readonly warned: boolean;
}

/** The domain expiring event warns this many days before the registration expires. */
export const domainExpiryWarningDays = 30;
