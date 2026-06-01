import { PIPELINE } from "../constants";

export default function PipelineStatus({ pipeline }) {
  if (!pipeline) return null;
  const p = PIPELINE[pipeline.status];
  if (!p) return null;
  return (
    <a
      href={pipeline.web_url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Pipeline: ${p.label}`}
      className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 whitespace-nowrap"
    >
      <span className={`w-2 h-2 rounded-full inline-block shrink-0 ${p.dot}`} />
      {p.label}
    </a>
  );
}
