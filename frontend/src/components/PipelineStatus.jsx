import { PIPELINE } from "../constants";

export default function PipelineStatus({ pipeline }) {
  if (pipeline === undefined) {
    return <div className="w-14 h-3 bg-gray-200 rounded animate-pulse" />;
  }
  if (!pipeline) return null;
  const p = PIPELINE[pipeline.status];
  if (!p) return null;
  return (
    <a
      href={pipeline.web_url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 whitespace-nowrap animate-in fade-in duration-300"
    >
      <span className={`w-2 h-2 rounded-full inline-block shrink-0 ${p.dot}`} />
      {p.label}
    </a>
  );
}
