// A reading projection of saved speech, shared by indexing and assistant tools.
// Only actual unit text enters the body; alignment, Jobs and recognition JSON do not.
/** @param {string | null | undefined} raw */
export function noteTranscriptText(raw) {
  if (typeof raw !== "string" || !raw.startsWith("[")) return "";
  let units;
  try {
    units = JSON.parse(raw);
  } catch {
    return "";
  }
  if (!Array.isArray(units)) return "";
  let text = "",
    previous;
  for (const unit of units) {
    if (!unit || typeof unit.text !== "string" || !unit.text.trim()) continue;
    const token = unit.text.trim();
    const boundary = previous && previous.source !== unit.source;
    const adjacent =
      !text ||
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(text) ||
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Punctuation}]/u.test(token);
    text += (boundary ? "\n" : adjacent ? "" : " ") + token;
    previous = unit;
  }
  return text;
}

/** @param {string | null | undefined} text @param {string} query @param {number} [limit] */
export function noteTextPreview(text, query, limit = 500) {
  if (!text) return "";
  const points = Array.from(text);
  if (points.length <= limit) return text;
  const lower = text.toLocaleLowerCase();
  const terms = [query.trim(), ...(query.match(/[\p{L}\p{N}_]+/gu) ?? [])].filter(Boolean);
  const match = terms
    .map((term) => lower.indexOf(term.toLocaleLowerCase()))
    .find((index) => index >= 0);
  const position = match === undefined ? 0 : Array.from(text.slice(0, match)).length;
  const start = Math.max(0, position - Math.floor(limit / 4));
  return (
    (start ? "…" : "") +
    points.slice(start, start + limit).join("") +
    (start + limit < points.length ? "…" : "")
  );
}
