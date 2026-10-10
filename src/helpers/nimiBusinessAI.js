const tokenStore = require("./tokenStore");
let readContext;
const message = (key) => require("./i18nMain").i18nMain.t(key);

function configure(reader) {
  readContext = reader;
}

async function assertAllowed() {
  const before = tokenStore.getState();
  // A business guest has no OpenWhispr bearer/organization. Nimi auth is separate.
  if (!before.token && !readContext) return;
  let context;
  try {
    context = readContext ? await readContext() : null;
  } catch {
    context = null;
  }
  const after = tokenStore.getState();
  if (before.generation !== after.generation || before.token !== after.token)
    throw Object.assign(new Error(message("nimi.businessAIUnresolved")), {
      code: "BUSINESS_AI_POLICY_UNRESOLVED",
    });
  if (
    context?.success === true &&
    context.managed === false &&
    ((context.status === "guest" && !before.token) ||
      (context.endpointSupported === true &&
        ["network", "current", "cached"].includes(context.status)))
  )
    return;
  const managed = context?.success === true && context.managed === true;
  throw Object.assign(
    new Error(message(managed ? "nimi.businessAIManaged" : "nimi.businessAIUnresolved")),
    {
      code: managed ? "BUSINESS_AI_POLICY_UNSUPPORTED" : "BUSINESS_AI_POLICY_UNRESOLVED",
    }
  );
}

module.exports = { configure, assertAllowed };
