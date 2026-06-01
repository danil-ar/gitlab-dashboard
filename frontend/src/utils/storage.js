const FILTERS_KEY  = "gl_filters";
const PROJECTS_KEY = "gl_selected_projects";
const DEFAULT_FILTERS = { state: "opened", scope: "all", search: "", project_id: "" };

export function loadFilters() {
  try {
    const saved = localStorage.getItem(FILTERS_KEY);
    return saved ? { ...DEFAULT_FILTERS, ...JSON.parse(saved) } : { ...DEFAULT_FILTERS };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

export function saveFilters(filters) {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch {}
}

export function loadSelectedProjects() {
  try {
    const saved = localStorage.getItem(PROJECTS_KEY);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  } catch { return new Set(); }
}

export function saveSelectedProjects(ids) {
  try {
    if (ids.size === 0) localStorage.removeItem(PROJECTS_KEY);
    else localStorage.setItem(PROJECTS_KEY, JSON.stringify([...ids]));
  } catch {}
}
