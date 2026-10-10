const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const { noteTranscriptText } = require("../utils/noteTranscriptText.mjs");

// Derived keyword tokens only. Stored notes and model output stay unchanged.
function noteKeywordText(value) {
  return typeof value === "string"
    ? value.normalize("NFC").replace(CJK, " $& ").replace(/\s+/g, " ").trim()
    : "";
}

function buildNoteSearchQuery(input) {
  if (typeof input !== "string") return "";
  const tokens = input
    .normalize("NFC")
    .match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu)
    ?.filter((token) => /[\p{L}\p{N}]/u.test(token));
  if (!tokens?.length) return "";
  return tokens.map((token) => `"${noteKeywordText(token).replace(/"/g, '""')}"*`).join(" ");
}

module.exports = { buildNoteSearchQuery, noteKeywordText, noteTranscriptText };
