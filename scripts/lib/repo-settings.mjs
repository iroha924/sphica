// Repository settings a release relies on that only an admin can read, so release.yml's GITHUB_TOKEN cannot check them.
// release:plan and release:status read them locally with the owner's gh and report each one as on, off, or unknown.

/**
 * The state of each setting from what `gh api` returned: `{ status, body }` per endpoint, status null when gh could not run.
 * Immutable releases answers 200 with `enabled` (observed with it off, although the docs say 404). A 404 is unknown, never off:
 * it also means a wrong repository name or no access.
 */
export function settingsState({ immutable, actions }) {
  const state = (on, off) => (on ? "on" : off ? "off" : "unknown");
  return [
    {
      name: "immutable releases",
      state: state(
        immutable.status === 200 && immutable.body?.enabled === true,
        immutable.status === 200 && immutable.body?.enabled === false,
      ),
    },
    {
      name: "SHA pinning required for actions",
      state: state(
        actions.status === 200 && actions.body?.sha_pinning_required === true,
        actions.status === 200 && actions.body?.sha_pinning_required === false,
      ),
    },
  ];
}

/** Reads one endpoint with gh: the HTTP status from gh's error text, the parsed body on success. */
export function observe(run, endpoint) {
  try {
    return { status: 200, body: JSON.parse(run(["api", endpoint])) };
  } catch (e) {
    const text = String(e && typeof e === "object" && "stderr" in e ? e.stderr : e);
    const code = /\(HTTP (\d{3})\)/.exec(text)?.[1];
    return { status: code ? Number(code) : null, body: null };
  }
}
