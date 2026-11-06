/** Commits as a reader needs them: who, what, and which ones nobody tied to an issue. Folds into one line. */
export default function CommitList({ commits, label, noKey, hiddenMerges = 0, open = noKey > 0 }) {
  if (commits.length === 0) return null;
  return (
    <details open={open} className="border border-gray-200 rounded-md text-xs">
      <summary className="px-2.5 py-2 font-medium text-gray-700 cursor-pointer select-none">
        {commits.length} commit{commits.length !== 1 ? "s" : ""} {label}
        {noKey > 0 && <span className="text-amber-700">, {noKey} without an issue key</span>}
        {hiddenMerges > 0 && <span className="font-normal text-gray-500"> · {hiddenMerges} merge commit{hiddenMerges !== 1 ? "s" : ""} not shown</span>}
      </summary>
      <ul className="max-h-48 overflow-y-auto border-t border-gray-100 divide-y divide-gray-100">
        {commits.map((c) => (
          <li key={c.short_id} className="px-2.5 py-1.5 flex items-baseline gap-2 min-w-0">
            <a href={c.url} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-700 hover:underline shrink-0">{c.short_id}</a>
            <span className="flex-1 min-w-0 truncate text-gray-800" title={c.title}>{c.title}</span>
            {c.issues.length === 0 && <span className="shrink-0 text-amber-700">no issue</span>}
            <span className="shrink-0 max-w-32 truncate text-gray-500" title={c.author}>{c.author}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
