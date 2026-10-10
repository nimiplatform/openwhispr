const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

test("StrictMode reveal failure stays visible and restores the button for another choice", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__mediaRevealCalls;
    delete globalThis.__mediaRevealToasts;
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  globalThis.__mediaRevealCalls = [];
  globalThis.__mediaRevealToasts = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "nimi-note-source-button-",
    mockModules: {
      "/services/nimiClient": `export async function invokeNimiBusiness(command,input) { globalThis.__mediaRevealCalls.push({command,input}); if(globalThis.__mediaRevealCalls.length===1) throw new Error("declared missing-media failure"); return {revealed:true}; }`,
      "/ui/useToast": `export const useToast=()=>({toast:value=>globalThis.__mediaRevealToasts.push(value)});`,
      "react-i18next": `export const useTranslation=()=>({t:key=>key});`,
      "/ui/button": `import {createElement} from "react"; export const Button=({variant,size,...props})=>createElement("button",props,props.children);`,
    },
  });
  const { NoteSourceMediaButton } = await vite.ssrLoadModule(
    "/components/notes/NoteSourceMediaButton.tsx"
  );
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(NoteSourceMediaButton, {
          noteId: 13,
          locale: "en",
          media: { originalPath: "imports/file/source.wav" },
        })
      )
    )
  );
  const find = (node) =>
    node.tagName === "BUTTON" ? node : (node.childNodes || []).map(find).find(Boolean);
  const props = (button) =>
    button[Object.keys(button).find((key) => key.startsWith("__reactProps"))];
  const click = () =>
    React.act(async () => {
      props(find(container)).onClick();
      await new Promise((resolve) => setImmediate(resolve));
    });
  await click();
  assert.equal(globalThis.__mediaRevealToasts.length, 1);
  assert.equal(
    globalThis.__mediaRevealToasts[0].technicalDetails.underlyingError,
    "declared missing-media failure"
  );
  assert.equal(props(find(container)).disabled, false);
  await click();
  assert.equal(globalThis.__mediaRevealCalls.length, 2);
  assert.deepEqual(globalThis.__mediaRevealCalls[1].input, { noteId: 13 });
  assert.equal(props(find(container)).disabled, false);
});
