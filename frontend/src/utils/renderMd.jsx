// Inline markdown renderer: `code`, **bold**, _italic_, @mention
const MD_PATTERN = /(`[^`]+`|\*\*[\s\S]+?\*\*|__[\s\S]+?__|_[^_]+_|\*[^*]+\*|@[\w.]+)/;

export function renderMd(text) {
  if (!text) return null;
  const segments = text.split(MD_PATTERN);
  return segments.map((seg, i) => {
    if (/^`[^`]+`$/.test(seg))
      return <code key={i} className="text-[11px] bg-white/15 px-1 py-0.5 rounded font-mono text-amber-300">{seg.slice(1, -1)}</code>;
    if (/^(\*\*|__)[\s\S]+?(\*\*|__)$/.test(seg))
      return <strong key={i} className="font-semibold text-white">{seg.slice(2, -2)}</strong>;
    if (/^(_|\*)[^_*]+(_|\*)$/.test(seg))
      return <em key={i} className="italic">{seg.slice(1, -1)}</em>;
    if (/^@[\w.]+$/.test(seg))
      return <span key={i} className="text-blue-400 font-medium">{seg}</span>;
    return seg;
  });
}
