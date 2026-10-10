const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer } = require("../lib/rendererTestHarness");
const fixture = require("../lib/mixedTranscriptFixture");

test("mixed transcript renders all unlabeled bodies, canceled status and each actual source clock", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "nimi-imported-transcript-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation=()=>({t:(key,p)=>({
        "nimi.recordingMedia.recording":"Recording "+p?.number,
        "nimi.recordingMedia.mic":"Microphone", "nimi.recordingMedia.system":"System audio",
        "nimi.recordingMedia.status.canceled":"Canceled"}[key]??key)});`,
      "./MeetingTranscriptChat": `export const SpeakerLabel=()=>null;`,
    },
  });
  const { ImportedTranscript } = await vite.ssrLoadModule(
    "/components/notes/ImportedTranscript.tsx"
  );
  const { parseTranscriptSegments } = await vite.ssrLoadModule("/utils/parseTranscriptSegments.ts");
  const { imported, recorded, media } = fixture();
  const markup = renderToStaticMarkup(
    React.createElement(ImportedTranscript, {
      segments: parseTranscriptSegments(JSON.stringify([imported[0], ...recorded, imported[1]])),
      originalText: "Hello, world!",
      media,
      originMs: media.transcriptOriginMs,
      selectedIds: new Set(),
      onToggleGroup() {},
    })
  );
  assert.match(markup, /Hello, world!/);
  assert.match(markup, /新发言。/);
  assert.match(markup, /New reply\./);
  assert.ok(markup.indexOf("Hello, world!") < markup.indexOf("新发言。"));
  assert.match(markup, /Recording 1/);
  assert.match(markup, /Canceled/);
  assert.match(markup, /0:02–5:04/);
  assert.match(markup, /0:01–0:01/);
  assert.doesNotMatch(markup, /0:20–0:20/);
  assert.equal((markup.match(/type="checkbox"/g) || []).length, 3);
});
