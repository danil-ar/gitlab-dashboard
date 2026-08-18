// Persisted UI state.
//
// Everything here is scoped per profile: project ids and project filters are
// meaningless across GitLab instances, so an unscoped key would send account
// A's project ids to account B's server and silently return nothing.

const FILTERS_KEY  = "gl_filters";
const PROJECTS_KEY = "gl_selected_projects";

const DEFAULT_FILTERS = { state: "opened", scope: "all", search: "", project_id: "" };

const key = (base, profileId) => (profileId ? `${base}:${profileId}` : base);

function read(name) {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function write(name, value) {
  try {
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
  } catch {
    /* private mode / quota — persistence is a nicety, not a requirement */
  }
}

// One-off carry-over from the unscoped keys used before profiles were scoped,
// so nobody loses their project selection on upgrade.
function adopt(base, profileId) {
  if (!profileId) return null;
  const legacy = read(base);
  if (legacy === null) return null;
  write(key(base, profileId), legacy);
  write(base, null);
  return legacy;
}

export function loadFilters(profileId) {
  const saved = read(key(FILTERS_KEY, profileId)) ?? adopt(FILTERS_KEY, profileId);
  if (!saved) return { ...DEFAULT_FILTERS };
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(saved) };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

export function saveFilters(profileId, filters) {
  write(key(FILTERS_KEY, profileId), JSON.stringify(filters));
}

export function loadSelectedProjects(profileId) {
  const saved = read(key(PROJECTS_KEY, profileId)) ?? adopt(PROJECTS_KEY, profileId);
  if (!saved) return new Set();
  try {
    const ids = JSON.parse(saved);
    return Array.isArray(ids) ? new Set(ids) : new Set();
  } catch {
    return new Set();
  }
}

export function saveSelectedProjects(profileId, ids) {
  write(key(PROJECTS_KEY, profileId), ids.size === 0 ? null : JSON.stringify([...ids]));
}
