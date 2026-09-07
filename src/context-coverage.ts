import type { YoofloeBundle, YoofloeWriterUnavailable } from "./types";

const NOTICE_MESSAGES: Record<string, string> = {
  EMPTY_CONTEXT: "No matching records were returned.",
  ENCRYPTED_CONTEXT_OMITTED: "Unreadable encrypted content was omitted. A PAT cannot unlock v2 text.",
  MONETARY_TOTALS_UNAVAILABLE: "Combined monetary totals are unavailable. They are not zero; currencies must not be combined without conversion."
};

/** Describes only the requested bundle's verified coverage; never invents a missing source. */
export function getContextNotices(bundle: YoofloeBundle): YoofloeWriterUnavailable[] {
  const notices: YoofloeWriterUnavailable[] = [];
  for (const domain of bundle.meta.domains) {
    const coverage = bundle.meta.coverage?.[domain];
    if (!coverage || !Array.isArray(coverage.notices)) {
      notices.push({ code: "COVERAGE_NOT_REPORTED", message: `${domain}: the server did not report context coverage. Completeness is unknown.` });
      continue;
    }
    for (const notice of coverage.notices) {
      const message = NOTICE_MESSAGES[notice.code];
      if (message) notices.push({ code: notice.code, message: `${domain}: ${message}` });
    }
  }
  notices.push({ code: "BOUNDED_CONTEXT", message: "This is a bounded context snapshot, not a complete export of your records." });
  return notices;
}
