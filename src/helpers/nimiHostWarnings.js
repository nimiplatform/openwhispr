// Windows supervised Hosts have no inherited stdio. Preserve Kit's existing
// bounded diagnostic in the App's normal debug log, without changing outcomes.
function captureNimiHostWarnings(logger, target = console) {
  const original = target.warn;
  const prefixes = new Set([
    "[nimi-shell] local App session invalidated",
    "[nimi-shell] local App session maintenance paused",
  ]);
  const captured = function (message, details, ...rest) {
    if (prefixes.has(message)) {
      const bounded = {};
      for (const key of ["method", "reasonCode"]) {
        if (typeof details?.[key] === "string") bounded[key] = details[key].slice(0, 160);
      }
      if (typeof details?.retryable === "boolean") bounded.retryable = details.retryable;
      try {
        logger.warn(message, bounded, "nimi-host");
      } catch {
        /* Logging cannot alter session control. */
      }
    }
    return original.call(target, message, details, ...rest);
  };
  target.warn = captured;
  return () => {
    if (target.warn === captured) target.warn = original;
  };
}

module.exports = { captureNimiHostWarnings };
