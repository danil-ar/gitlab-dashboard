const GLYPHS = {
  mr:          <path d="M4.5 3v10M11.5 7v6M4.5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm7 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM11.5 7c-3 0-4-1.5-4-3" />,
  thumb:       <path d="M5 7v6.5a.5.5 0 0 0 .5.5h6.4a1 1 0 0 0 1-.8l.9-4.7a.5.5 0 0 0-.5-.6H10V5a1.5 1.5 0 0 0-3 0L5 7Zm0 0H2.5v6.5H5" />,
  at:          <path d="M8 13.5A5.5 5.5 0 1 1 13.5 8M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm3-3v.5a1.5 1.5 0 0 0 3 0V8" />,
  mention:     <path d="M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 4v.5M13 8A5 5 0 1 1 3 8a5 5 0 0 1 10 0Zm0 0c0 1.1-.4 2-1.5 2S10 9.1 10 8" />,
  check:       <path d="M3 8.5 6.5 12 13 4.5" />,
  alert:       <path d="M8 2.5 14 13H2L8 2.5Z M8 6.5v3.5 M8 11.5v.01" />,
  star:        <path d="m8 2 1.7 3.6 3.8.5-2.8 2.7.7 3.9L8 10.8l-3.4 1.9.7-3.9L2.5 6.1l3.8-.5L8 2Z" />,
  inbox:       <path d="M2.5 9.5V3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6m-11 0v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3m-11 0h3l1 2h3l1-2h3" />,
  issue:       <path d="M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z M8 5v3.5 M8 11v.01" />,
  epic:        <path d="M2.5 3.5a1 1 0 0 1 1-1h3a2 2 0 0 1 1.5.7A2 2 0 0 1 9.5 2.5h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3a2 2 0 0 0-1.5.7 2 2 0 0 0-1.5-.7h-3a1 1 0 0 1-1-1v-8Z M8 4v8.5" />,
  clock:       <><circle cx="8" cy="8" r="6" /><path d="M8 5v3.5l2 1" /></>,
  refresh:     <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c2 0 3.7 1 4.7 2.5M13.5 2.5V5H11" />,
  search:      <><circle cx="6.5" cy="6.5" r="4.5" /><path d="M10 10l3 3" /></>,
  filter:      <path d="M2 4h12M4 8h8M6 12h4" />,
  chevronDown: <path d="M4 6l4 4 4-4" />,
  chevronLeft: <path d="M10 3L5 8l5 5" />,
  close:       <path d="M4 4l8 8M12 4l-8 8" />,
  info:        <><circle cx="8" cy="8" r="5.5" /><path d="M8 7v4M8 5.5v.5" /></>,
  chat:        <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H9l-3 3v-3H3.5A1.5 1.5 0 0 1 2 9.5v-6Z" />,
  gear:        <><path d="M6.5 2h3l.5 1.5 1.2-.5 2 2-.5 1.2L14 7v2l-1.3.8.5 1.2-2 2-1.2-.5L9.5 14h-3l-.5-1.5-1.2.5-2-2 .5-1.2L2 9V7l1.3-.8-.5-1.2 2-2 1.2.5L6.5 2Z" /><circle cx="8" cy="8" r="2" /></>,
  todo:        <><rect x="2" y="2" width="12" height="12" rx="1.5" /><path d="M5 8l2 2 4-4" /></>,
  circle:      <circle cx="8" cy="8" r="5.5" />,
  circleX:     <><circle cx="8" cy="8" r="5.5" /><path d="M5.5 5.5l5 5m0-5l-5 5" /></>,
  circlePlus:  <><circle cx="8" cy="8" r="5.5" /><path d="M8 5.5v5M5.5 8h5" /></>,
  signOut:     <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M10.5 11l3-3-3-3M13.5 8H6" />,
  tag:         <path d="M2.5 2.5h5l6 6-5 5-6-6v-5Z M5.5 5.5v.01" />,
};

const BUCKET_GLYPHS = { needs: "alert", approved: "thumb", mine: "mr", mention: "mention" };

export function Icon({ name, className = "w-3.5 h-3.5", strokeWidth = 1.5 }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {GLYPHS[name]}
    </svg>
  );
}

export function BucketIcon({ id, className }) {
  return <Icon name={BUCKET_GLYPHS[id]} className={className} />;
}

export function IconSpin({ className = "w-3 h-3" }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M8 2a6 6 0 1 0 6 6" strokeLinecap="round" />
    </svg>
  );
}
