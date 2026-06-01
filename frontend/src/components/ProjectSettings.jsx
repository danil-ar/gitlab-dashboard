import { useState } from "react";
import { loadSelectedProjects, saveSelectedProjects } from "../utils/storage";

export default function ProjectSettings({ projects, onClose }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(loadSelectedProjects);

  const filtered = projects
    .filter((p) => p.path_with_namespace.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)));

  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id));

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    saveSelectedProjects(next);
    return next;
  });

  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allFilteredSelected) filtered.forEach((p) => next.delete(p.id));
    else                     filtered.forEach((p) => next.add(p.id));
    saveSelectedProjects(next);
    return next;
  });

  const clearAll = () => {
    const empty = new Set();
    setSelected(empty);
    saveSelectedProjects(empty);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900">Project filter</h2>
          <div className="flex items-center gap-3">
            {selected.size > 0 && <button onClick={clearAll} className="text-xs text-gray-400 hover:text-gray-600">Clear all ({selected.size})</button>}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
          </div>
        </div>
        <div className="px-5 py-3 border-b border-gray-100">
          <input autoFocus type="search" placeholder="Filter projects…" value={search} onChange={(e) => setSearch(e.target.value)}
                 className="w-full text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="px-5 py-2 border-b border-gray-100 flex items-center gap-2">
          <input type="checkbox" id="toggle-all" checked={allFilteredSelected} onChange={toggleAll} className="rounded" />
          <label htmlFor="toggle-all" className="text-xs text-gray-500 cursor-pointer select-none">
            {allFilteredSelected ? "Deselect all" : "Select all"} ({filtered.length})
          </label>
          {selected.size === 0 && <span className="ml-auto text-xs text-gray-400">No selection = show all</span>}
        </div>
        <div className="overflow-y-auto flex-1 px-2 py-2">
          {filtered.length === 0 ? (
            <p className="text-center py-8 text-sm text-gray-400">No projects found</p>
          ) : filtered.map((p) => (
            <label key={p.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="rounded shrink-0" />
              <span className="text-sm text-gray-700 truncate">{p.path_with_namespace}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
