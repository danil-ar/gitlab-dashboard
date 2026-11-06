import { useState } from "react";
import { copyText } from "../utils/reviewMessage";

export default function CopyBlock({ title, text }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between mb-1.5">
        <h3 className="text-xs font-semibold text-gray-700">{title}</h3>
        <button
          onClick={copy}
          disabled={!text}
          className="text-xs px-2 py-1 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      {/* Wraps and grows with its content: a fixed-size field clips lines behind Windows scrollbars. */}
      <pre
        className="font-mono text-[11px] leading-relaxed border border-gray-200 rounded-md p-2 bg-gray-50 text-gray-700 whitespace-pre-wrap break-words"
      >
        {text || <span className="text-gray-500">Nothing to do</span>}
      </pre>
    </div>
  );
}
