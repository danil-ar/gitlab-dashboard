const TONES = {
  error:   { box: "bg-red-50 border-red-200 text-red-700", action: "text-red-600 hover:text-red-800" },
  warning: { box: "bg-amber-50 border-amber-200 text-amber-800", action: "text-amber-700 hover:text-amber-900" },
};

export default function Banner({ tone = "error", onRetry, onDismiss, className = "", children }) {
  const { box, action } = TONES[tone];
  const actionClass = `shrink-0 font-medium underline underline-offset-2 ${action}`;
  return (
    <div className={`p-3 border rounded-md text-sm flex items-start gap-3 ${box} ${className}`}>
      <div className="flex-1 min-w-0 break-words">{children}</div>
      {onRetry && <button onClick={onRetry} className={actionClass}>Retry</button>}
      {onDismiss && <button onClick={onDismiss} className={actionClass}>Dismiss</button>}
    </div>
  );
}
