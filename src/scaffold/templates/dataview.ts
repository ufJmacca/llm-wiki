export function ingestionQueueDashboardContent(): string {
  return `${dashboardFrontmatter("Ingestion Queue")}# Ingestion Queue

\`\`\`dataview
TABLE source_kind, status, captured_at, tags
FROM "raw/inputs"
WHERE type = "raw_source" AND status != "ingested"
SORT captured_at DESC
\`\`\`
`;
}

export function needsReviewDashboardContent(): string {
  return `${dashboardFrontmatter("Needs Review")}# Needs Review

\`\`\`dataview
TABLE type, updated, source_count, next_review
FROM "curated"
WHERE review_status = "needs-human-review"
SORT updated DESC
\`\`\`
`;
}

function dashboardFrontmatter(title: string): string {
  return `---
type: dashboard
title: ${title}
visibility: private
source_ids: []
---

`;
}
