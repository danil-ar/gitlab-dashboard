// Inline markdown renderer: `code`, **bold**, _italic_, @mention, #123
// The word-boundary checks keep snake_case_names and foo#1 from being read as markup.
const MD_PATTERN = /(`[^`]+`|\*\*[\s\S]+?\*\*|__[\s\S]+?__|(?<!\w)_[^_]+_(?!\w)|\*[^*]+\*|@\w[\w.-]*|(?<!\w)#\d+)/;

export function renderMd(text) {
  if (!text) return null;
  const segments = text.split(MD_PATTERN);
  return segments.map((seg, i) => {
    if (/^`[^`]+`$/.test(seg))
      return <code key={i} className="text-[11px] bg-black/8 px-1 py-0.5 rounded font-mono">{seg.slice(1, -1)}</code>;
    if (/^(\*\*|__)[\s\S]+?(\*\*|__)$/.test(seg))
      return <strong key={i} className="font-semibold">{seg.slice(2, -2)}</strong>;
    if (/^(_|\*)[^_*]+(_|\*)$/.test(seg))
      return <em key={i} className="italic">{seg.slice(1, -1)}</em>;
    if (/^@\w[\w.-]*$/.test(seg))
      return <span key={i} className="text-blue-700 font-medium">{seg}</span>;
    if (/^#\d+$/.test(seg))
      return <span key={i} className="text-blue-700 font-mono">{seg}</span>;
    return seg;
  });
}
