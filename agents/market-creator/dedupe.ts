/**
 * Dedupe helpers for market-creator candidates.
 *
 * Two candidates are considered duplicates when they share the same
 * (question, resolutionUrl, deadline) signature. Deadlines are interpreted
 * with their explicit time-zone designator or metadata and normalized to a
 * canonical UTC timestamp while retaining the source time zone as metadata.
 * Ambiguous local-only deadlines are rejected.
 */

import {
  interpretDeadline,
  parseExplicitDeadline,
  formatUtcOffset,
  type DeadlineInterpretation,
  type DeadlineParseResult,
  type DeadlineRejectionReason,
} from "./drafting.js";

export interface CandidateLike {
  question?: string;
  resolutionUrl?: string;
  /** Deadline timestamp (normalized to canonical UTC ISO-8601 when valid). */
  deadline?: string;
  /** Retained source time-zone designator or IANA zone metadata (e.g. "UTC", "+02:00", "America/New_York"). */
  sourceZone?: string;
  /** Optional explicit time-zone input field (IANA zone or UTC offset). */
  timeZone?: string;
  /** Optional lowercase alias for explicit time-zone metadata. */
  timezone?: string;
  /** Structured time-zone interpretation metadata for `deadline`. */
  deadlineInterpretation?: DeadlineInterpretation;
  // Optional canonical fields that may be present on candidates.
  id?: string;
  title?: string;
  [key: string]: unknown;
}

function normaliseQuestion(question: string | undefined): string {
  if (!question) return "";
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseUrl(url: string | undefined): string {
  if (!url) return "";
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function extractExplicitZoneFromCandidate(
  candidate: CandidateLike,
): { ok: true; zone?: string; fromSourceZoneOnly: boolean } | { ok: false } {
  const inputKeys = ["timeZone", "timezone", "deadlineTimeZone", "deadlineTimezone"] as const;
  let selectedInput: string | undefined;

  for (const key of inputKeys) {
    const val = candidate[key];
    if (val === undefined || val === null) continue;
    if (typeof val !== "string") return { ok: false };
    const trimmed = val.trim();
    if (!trimmed) return { ok: false };
    if (selectedInput !== undefined && selectedInput.toLowerCase() !== trimmed.toLowerCase()) {
      return { ok: false };
    }
    selectedInput = trimmed;
  }

  if (candidate.sourceZone !== undefined && candidate.sourceZone !== null) {
    if (typeof candidate.sourceZone !== "string") return { ok: false };
    const trimmedSource = candidate.sourceZone.trim();
    if (!trimmedSource) return { ok: false };
    if (selectedInput !== undefined && selectedInput.toLowerCase() !== trimmedSource.toLowerCase()) {
      return { ok: false };
    }
    if (selectedInput === undefined) {
      return { ok: true, zone: trimmedSource, fromSourceZoneOnly: true };
    }
  }

  return { ok: true, zone: selectedInput, fromSourceZoneOnly: false };
}

/**
 * Resolve and validate the deadline on a candidate object, returning the
 * canonical UTC timestamp and retained source time-zone metadata, or `null`
 * if the deadline is missing, malformed, or an ambiguous local-only timestamp.
 */
export function resolveCandidateDeadline(candidate: CandidateLike): DeadlineInterpretation | null {
  if (typeof candidate.deadline !== "string") return null;
  const rawDeadline = candidate.deadline.trim();
  if (!rawDeadline) return null;

  const zoneField = extractExplicitZoneFromCandidate(candidate);
  if (!zoneField.ok) return null;

  // If the candidate already carries a validated deadlineInterpretation matching its canonical UTC deadline,
  // verify it and preserve its original rawDeadline and sourceZone metadata.
  if (
    candidate.deadlineInterpretation &&
    typeof candidate.deadlineInterpretation === "object" &&
    candidate.deadlineInterpretation.canonicalUtc === rawDeadline &&
    typeof candidate.deadlineInterpretation.rawDeadline === "string" &&
    typeof candidate.deadlineInterpretation.sourceZone === "string"
  ) {
    const verified = interpretDeadline(
      candidate.deadlineInterpretation.rawDeadline,
      candidate.deadlineInterpretation.sourceZone,
    );
    if (verified && verified.canonicalUtc === rawDeadline) {
      if (
        zoneField.zone === undefined ||
        zoneField.zone.toLowerCase() === verified.sourceZone.toLowerCase()
      ) {
        return verified;
      }
    }
  }

  const direct = interpretDeadline(rawDeadline, zoneField.zone);
  if (direct) return direct;

  // Handle already-normalized candidates where `deadline` is a canonical UTC `Z` string
  // and `sourceZone` records the original non-UTC source zone as metadata.
  if (zoneField.fromSourceZoneOnly && zoneField.zone && /[Zz]$/.test(rawDeadline)) {
    const utcParsed = interpretDeadline(rawDeadline);
    if (!utcParsed) return null;
    // Validate that `sourceZone` itself is a legitimate explicit zone by probing a sample wall-clock date.
    const zoneProbe = interpretDeadline("2026-01-15T12:00:00", zoneField.zone);
    if (!zoneProbe) return null;
    return {
      canonicalUtc: utcParsed.canonicalUtc,
      sourceZone: zoneProbe.sourceZone,
      offsetMinutes: zoneProbe.offsetMinutes,
      utcOffset: zoneProbe.utcOffset,
      rawDeadline: candidate.deadlineInterpretation?.rawDeadline ?? rawDeadline,
    };
  }

  return null;
}

/**
 * Normalize a deadline string to its canonical UTC ISO-8601 timestamp.
 *
 * Requires an explicit time-zone designator in `deadline` (e.g. `Z` or `±HH:MM`)
 * or an explicit `explicitZone` argument (IANA zone or UTC offset).
 * Returns `""` when `deadline` is empty, malformed, or an ambiguous local-only value.
 */
export function normaliseDeadline(
  deadline: string | undefined,
  explicitZone?: string,
): string {
  if (!deadline) return "";
  const interpreted = interpretDeadline(deadline, explicitZone);
  if (!interpreted) return "";
  return interpreted.canonicalUtc;
}

export const normalizeDeadline = normaliseDeadline;

/**
 * Build a stable signature for a candidate. Used to detect duplicates
 * across the same run and against already-created markets.
 *
 * Equivalent deadlines across different explicit time zones normalize to the
 * same canonical UTC timestamp in the signature. Ambiguous local-only deadlines
 * are tagged as invalid rather than interpreted in the host machine's local zone.
 */
export function buildCandidateSignature(candidate: CandidateLike): string {
  const question = normaliseQuestion(candidate.question ?? candidate.title);
  const url = normaliseUrl(candidate.resolutionUrl);
  if (candidate.deadline === undefined || candidate.deadline === "") {
    return `${question}|${url}|`;
  }
  const resolved = resolveCandidateDeadline(candidate);
  const deadlineKey = resolved
    ? resolved.canonicalUtc
    : `invalid:${String(candidate.deadline).trim().toLowerCase()}`;
  return `${question}|${url}|${deadlineKey}`;
}

/**
 * Filter duplicate candidates while preserving input order.
 *
 * When a candidate specifies a `deadline`, it must have an explicit time-zone
 * interpretation; candidates with ambiguous local-only or malformed deadlines
 * are rejected. Kept candidates have their `deadline` normalized to a canonical
 * UTC timestamp with `sourceZone` and `deadlineInterpretation` retained as metadata.
 *
 * The first occurrence of a signature wins; subsequent ones are dropped.
 * An optional `seen` set can be passed in to also dedupe against candidates
 * that already exist on-chain or in a previous batch.
 */
export function filterDuplicateCandidates<T extends CandidateLike>(
  candidates: readonly T[],
  seen: Set<string> = new Set(),
): T[] {
  const out: T[] = [];
  for (const candidate of candidates) {
    if (candidate.deadline !== undefined) {
      const resolved = resolveCandidateDeadline(candidate);
      if (!resolved) continue;

      const question = normaliseQuestion(candidate.question ?? candidate.title);
      const url = normaliseUrl(candidate.resolutionUrl);
      const sig = `${question}|${url}|${resolved.canonicalUtc}`;
      if (seen.has(sig)) continue;
      seen.add(sig);

      if (
        candidate.deadline === resolved.canonicalUtc &&
        candidate.sourceZone === resolved.sourceZone &&
        candidate.deadlineInterpretation !== undefined
      ) {
        out.push(candidate);
      } else {
        out.push({
          ...candidate,
          deadline: resolved.canonicalUtc,
          sourceZone: resolved.sourceZone,
          deadlineInterpretation: resolved,
        });
      }
      continue;
    }

    const sig = buildCandidateSignature(candidate);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(candidate);
  }
  return out;
}

export {
  interpretDeadline,
  parseExplicitDeadline,
  formatUtcOffset,
  type DeadlineInterpretation,
  type DeadlineParseResult,
  type DeadlineRejectionReason,
};
