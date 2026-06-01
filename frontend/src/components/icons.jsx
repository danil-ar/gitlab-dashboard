export function BucketIcon({ id, className }) {
  const path = {
    needs:    "M8 2.5 14 13H2L8 2.5Z M8 6.5v3.5 M8 11.5v.01",
    approved: "M5 7v6.5a.5.5 0 0 0 .5.5h6.4a1 1 0 0 0 1-.8l.9-4.7a.5.5 0 0 0-.5-.6H10V5a1.5 1.5 0 0 0-3 0L5 7Zm0 0H2.5v6.5H5",
    mine:     "M4.5 3v10M11.5 7v6M4.5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm7 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM11.5 7c-3 0-4-1.5-4-3",
    mention:  "M2.5 9.5V3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6m-11 0v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3m-11 0h3l1 2h3l1-2h3",
  }[id];
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconRefresh({ className }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c2 0 3.7 1 4.7 2.5M13.5 2.5V5H11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconSearch({ className }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="6.5" cy="6.5" r="4.5" />
      <path d="M10 10l3 3" strokeLinecap="round" />
    </svg>
  );
}

export function IconFilter({ className }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 4h12M4 8h8M6 12h4" strokeLinecap="round" />
    </svg>
  );
}

export function IconClock({ className }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5l2 1" strokeLinecap="round" />
    </svg>
  );
}
