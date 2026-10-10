// Unmarked historical vectors have no known space and cannot be matched.
function representation(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["vector", "spaceId"].includes(key)) ||
    typeof value.spaceId !== "string" ||
    !value.spaceId ||
    value.spaceId.trim() !== value.spaceId ||
    Buffer.byteLength(value.spaceId, "utf8") > 128 ||
    !Array.isArray(value.vector) ||
    value.vector.length < 1 ||
    value.vector.length > 4096 ||
    value.vector.some((item) => typeof item !== "number" || !Number.isFinite(item)) ||
    !value.vector.some((item) => item !== 0)
  )
    throw new Error("Invalid speaker representation");
  return { vector: [...value.vector], spaceId: value.spaceId };
}
function parseRepresentation(value) {
  try {
    return representation(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return null;
  }
}
function compatible(a, b) {
  const left = parseRepresentation(a),
    right = parseRepresentation(b);
  return Boolean(
    left && right && left.spaceId === right.spaceId && left.vector.length === right.vector.length
  );
}
function weightedCentroid(a, b, leftCount = 1, rightCount = 1) {
  if (!compatible(a, b)) throw new Error("Speaker representation spaces differ");
  if (
    !Number.isSafeInteger(leftCount) ||
    leftCount < 1 ||
    !Number.isSafeInteger(rightCount) ||
    rightCount < 1
  )
    throw new Error("Invalid speaker sample count");
  return representation({
    spaceId: a.spaceId,
    vector: a.vector.map(
      (value, i) =>
        value * (leftCount / (leftCount + rightCount)) +
        b.vector[i] * (rightCount / (leftCount + rightCount))
    ),
  });
}
function computeCentroid(values) {
  if (!values.length) throw new Error("Speaker centroid requires actual representations");
  return values
    .slice(1)
    .reduce(
      (value, next, index) => weightedCentroid(value, next, index + 1, 1),
      representation(values[0])
    );
}
function cosineSimilarity(a, b) {
  if (!compatible(a, b)) return null;
  const scaleA = Math.max(...a.vector.map(Math.abs)),
    scaleB = Math.max(...b.vector.map(Math.abs));
  let dot = 0,
    left = 0,
    right = 0;
  for (let i = 0; i < a.vector.length; i++) {
    const x = a.vector[i] / scaleA,
      y = b.vector[i] / scaleB;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(left * right)));
}
module.exports = {
  representation,
  parseRepresentation,
  compatible,
  weightedCentroid,
  computeCentroid,
  cosineSimilarity,
};
