/**
 * Masking helpers for the **public** campaign cap table. Holdings are read from an
 * on-chain, inherently public ledger, but we still avoid trivially doxxing investors:
 * wallet addresses are truncated and any display name is reduced to initials. Legal
 * KYC names are never routed through here.
 */

/**
 * Truncate a Stellar address (56 chars) to `GCUQ…OCBY` — enough to recognise a
 * wallet you already know without publishing the full key. Short/empty input is
 * returned unchanged (nothing meaningful to hide).
 */
export function maskAddress(addr: string): string {
  if (!addr || addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/**
 * Reduce a display name to per-word initials, e.g. `"Budi Santoso"` → `"B*** S***"`.
 * `null` (unregistered holder or no chosen name) stays `null`.
 */
export function maskName(name: string | null): string | null {
  if (name === null) return null;
  const masked = name
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word[0]}***`)
    .join(' ');
  return masked.length > 0 ? masked : null;
}
