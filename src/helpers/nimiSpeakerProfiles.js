const vectors = require("./speakerRepresentation");
const {
  canAutoRelabelSpeaker,
  applyConfirmedSpeaker,
  applySuggestedSpeaker,
} = require("./speakerAssignmentPolicy");

// Person names belong to the business note and device profiles. Runtime IDs
// identify voices within one Job; they do not identify people.
function labelSpeakerProfiles(segments, representations, profiles, mappings = []) {
  return segments.map((source) => {
    const segment = { ...source };
    if (!segment.speaker || !canAutoRelabelSpeaker(segment)) return segment;
    const mapping = mappings.find((entry) => entry.speaker_id === segment.speaker);
    if (mapping) {
      return applyConfirmedSpeaker(segment, {
        speakerName: mapping.display_name,
        speakerIsPlaceholder: false,
        suggestedName: undefined,
        suggestedProfileId: undefined,
      });
    }
    if (segment.speakerMatching && segment.speakerMatching !== "matched-space") return segment;
    const representation = representations[segment.speaker];
    if (!representation) return segment;
    const ranked = profiles
      .map((profile) => {
        const similarities = (profile.representations || [])
          .map((value) => vectors.cosineSimilarity(representation, value))
          .filter((value) => value !== null);
        return { profile, similarity: similarities.length ? Math.max(...similarities) : -1 };
      })
      .sort((a, b) => b.similarity - a.similarity);
    const best = ranked[0];
    if (!best || best.similarity <= 0.5) return segment;
    const separated = !ranked[1] || best.similarity - ranked[1].similarity >= 0.03;
    if (best.similarity > 0.65 && separated) {
      return applyConfirmedSpeaker(segment, {
        speakerName: best.profile.display_name,
        speakerIsPlaceholder: false,
        suggestedName: undefined,
        suggestedProfileId: undefined,
      });
    }
    return applySuggestedSpeaker(segment, {
      suggestedName: best.profile.display_name,
      suggestedProfileId: best.profile.id,
    });
  });
}

module.exports = { labelSpeakerProfiles };
