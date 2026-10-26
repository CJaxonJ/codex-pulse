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

function boundedObjective(full, original, handoff) {
  if (full.length <= 4000) return full;
  const prefix = original
    ? `Original user-approved goal (authoritative; preserve exactly):\n${original}\n\n`
    : "Continue only the unfinished user request in this thread. Inspect its saved checkpoint and existing work.\n\n";
  const label = "Next action:\n";
  // A near-limit original Goal must remain exact. Progress is also persisted
  // outside the Goal and supplied by UserPromptSubmit when supported.
  if (prefix.length + label.length >= 4000) return original || full.slice(0, 4000);
  const next = handoff.nextAction || handoff.remaining || "Inspect the interrupted turn and reconstruct remaining steps before editing.";
  return prefix + label + next.slice(0, 4000 - prefix.length - label.length).replace(/[\uD800-\uDBFF]$/, "");
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
  return { objective: boundedObjective(objective, original, handoff), originalObjective: original, handoff };
}

export function buildRecoveryGoal({ checkpointSummary }) {
  const summary = String(checkpointSummary || "").trim();
  if (!summary) return null;
  const handoff = parseQuotaHandoff(summary);
  const objective = [
    "Codex Pulse quota-recovery continuation goal",
    "",
    "Authoritative scope:",
    "Continue the unfinished user request from the immediately preceding quota-paused turn. Use the existing thread context as the source of truth, preserve completed work, and do not expand scope.",
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
    "- The existing thread context remains authoritative.",
    "- Preserve completed work and use verification only as evidence, not as proof of unverified claims.",
    "- Continue only unfinished work, beginning with Next action.",
    "- Do not expand scope or mark the Goal complete until the user's request is verified.",
  ].join("\n");
  return { objective: boundedObjective(objective, null, handoff), handoff };
}
