const HANDOFF_LABELS = new Map([
  ["completed", "completed"],
  ["verification", "verification"],
  ["remaining", "remaining"],
  ["next action", "nextAction"],
  ["blockers", "blockers"],
]);

function cleanLabel(line) {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replaceAll("**", "")
    .replaceAll("__", "")
    .replace(/^[-*]\s*/, "");
}

export function parseQuotaHandoff(summary = "") {
  const sections = {};
  let active = null;
  const normalized = String(summary).replace(
    /\s+(?=(?:Completed|Verification|Remaining|Next action|Blockers)\s*[:：])/gi,
    "\n",
  );
  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = cleanLabel(rawLine);
    const match = line.match(
      /^(Completed|Verification|Remaining|Next action|Blockers)\s*[:：]?\s*(.*)$/i,
    );
    if (match) {
      active = HANDOFF_LABELS.get(match[1].toLowerCase());
      sections[active] = match[2].trim();
      continue;
    }
    if (active && line) {
      sections[active] = [sections[active], line].filter(Boolean).join("\n");
    }
  }
  return sections;
}

function section(label, value, fallback) {
  return `${label}:\n${String(value || fallback).trim()}`;
}

export function buildContinuationGoal({ originalObjective, checkpointSummary }) {
  const original = String(originalObjective || "");
  if (!original.trim()) return null;
  const summary = String(checkpointSummary || "").trim();
  const handoff = parseQuotaHandoff(summary);
  const objective = [
    "Codex Pulse quota-recovery continuation goal",
    "",
    "Original user-approved goal (authoritative; preserve exactly):",
    original,
    "",
    "Pause-time progress:",
    section("Completed", handoff.completed, "Nothing was recorded as completed."),
    "",
    section("Verification", handoff.verification, "No verification was recorded."),
    "",
    section("Remaining", handoff.remaining, "Inspect the checkpoint and identify unfinished work."),
    "",
    section("Next action", handoff.nextAction, "Continue from the first unfinished step."),
    "",
    section("Blockers", handoff.blockers, "None recorded."),
    "",
    "Continuation contract:",
    "- The original user-approved goal remains the source of truth.",
    "- Preserve completed work and use verification only as evidence, not as proof of unverified claims.",
    "- Continue only the unfinished work, beginning with Next action.",
    "- Do not expand scope or mark the Goal complete until the original goal is verified.",
  ].join("\n");
  return { objective, originalObjective: original, handoff };
}
