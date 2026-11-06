import Modal from "./Modal";
import { useState, useMemo } from "react";
import { loadSelectedProjects, saveSelectedProjects } from "../utils/storage";

function namespace(p) {
  const parts = p.path_with_namespace.split("/");
  return parts.slice(0, -1).join("/");
}

function projectName(p) {
  const parts = p.path_with_namespace.split("/");
  return parts[parts.length - 1];
}

export default function ProjectSettings({ projects, profileId, onClose }) {
  const [search, setSearch]     = useState("");
  const [selected, setSelected] = useState(() => loadSelectedProjects(profileId));

  const save = (next) => { saveSelectedProjects(profileId, next); return next; };

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return save(next);
  });

  const toggleGroup = (groupProjects) => setSelected((prev) => {
    const next = new Set(prev);
    const allSelected = groupProjects.every((p) => next.has(p.id));
    groupProjects.forEach((p) => allSelected ? next.delete(p.id) : next.add(p.id));
    return save(next);
  });

  const clearAll = () => setSelected(save(new Set()));

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q
      ? projects.filter((p) => p.path_with_namespace.toLowerCase().includes(q))
      : projects;
  }, [projects, search]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const p of filtered) {
      const ns = namespace(p);
      if (!map.has(ns)) map.set(ns, []);
      map.get(ns).push(p);
    }
    // Sort: groups with more selected projects first, then alphabetically
    return [...map.entries()]
      .sort(([nsA, psA], [nsB, psB]) => {
        const selA = psA.filter((p) => selected.has(p.id)).length;
        const selB = psB.filter((p) => selected.has(p.id)).length;
        if (selB !== selA) return selB - selA;
        return nsA.localeCompare(nsB);
      })
      .map(([ns, ps]) => ({
        ns,
        projects: ps.sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace)),
      }));
  }, [filtered, selected]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id));

  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allFilteredSelected) filtered.forEach((p) => next.delete(p.id));
    else filtered.forEach((p) => next.add(p.id));
    return save(next);
  });

  return (
    <Modal label="Project filter" onClose={onClose} className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">

      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-900">Project filter</h2>
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <button onClick={clearAll} className="text-xs text-gray-500 hover:text-gray-600">
              Clear all ({selected.size})
            </button>
          )}
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600 text-lg leading-none">✕</button>
        </div>
      </div>

      <div className="px-5 py-3 border-b border-gray-100">
        <input
          autoFocus type="text" placeholder="Filter projects…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-full text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="px-5 py-2 border-b border-gray-100 flex items-center gap-2">
        <input type="checkbox" id="toggle-all" checked={allFilteredSelected} onChange={toggleAll} className="rounded" />
        <label htmlFor="toggle-all" className="text-xs text-gray-500 cursor-pointer select-none">
          {allFilteredSelected ? "Deselect all" : "Select all"} ({filtered.length})
        </label>
        {selected.size === 0 && (
          <span className="ml-auto text-xs text-gray-500">No selection = show all</span>
        )}
      </div>

      <div className="overflow-y-auto flex-1 py-2">
        {filtered.length === 0 ? (
          <p className="text-center py-8 text-sm text-gray-500">No projects found</p>
        ) : groups.map(({ ns, projects: gps }) => {
          const groupSelected = gps.filter((p) => selected.has(p.id)).length;
          const allGroupSelected = groupSelected === gps.length;
          const someGroupSelected = groupSelected > 0 && !allGroupSelected;

          return (
            <div key={ns}>
              {/* group header */}
              <div className="flex items-center gap-2 px-4 py-1.5 bg-gray-50 border-y border-gray-100 sticky top-0">
                <input
                  type="checkbox"
                  checked={allGroupSelected}
                  ref={(el) => { if (el) el.indeterminate = someGroupSelected; }}
                  onChange={() => toggleGroup(gps)}
                  className="rounded shrink-0"
                />
                <span
                  className="text-xs font-semibold text-gray-500 cursor-pointer select-none flex-1"
                  onClick={() => toggleGroup(gps)}
                >
                  {ns}
                </span>
                <span className="text-[11px] text-gray-500 tabular-nums">
                  {groupSelected}/{gps.length}
                </span>
              </div>

              {/* projects in group */}
              {gps.map((p) => (
                <label key={p.id} className="flex items-center gap-3 px-4 pl-8 py-2 hover:bg-gray-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                    className="rounded shrink-0"
                  />
                  <span className="text-sm text-gray-700 truncate">{projectName(p)}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
