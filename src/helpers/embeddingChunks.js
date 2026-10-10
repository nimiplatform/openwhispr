const MAX_INPUT_BYTES = 32 * 1024;

// Split original text only at Unicode scalar boundaries. Model token limits
// remain model/Runtime behavior; this enforces the public per-input byte budget.
function chunkEmbeddingText(text) {
  const chunks = [];
  let current = "";
  let bytes = 0;
  for (const scalar of text) {
    const size = Buffer.byteLength(scalar, "utf8");
    if (bytes + size > MAX_INPUT_BYTES) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += scalar;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}
module.exports = { chunkEmbeddingText };
