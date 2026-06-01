export const STATE_OPTS = [
  { value: "opened", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all",    label: "All" },
];

export const SCOPE_OPTS = [
  { value: "all",             label: "All MRs" },
  { value: "created_by_me",   label: "Created by me" },
  { value: "assigned_to_me",  label: "Assigned to me" },
];

export const PIPELINE = {
  success:              { dot: "bg-green-500",              label: "passed"    },
  failed:               { dot: "bg-red-500",                label: "failed"    },
  running:              { dot: "bg-blue-400 animate-pulse", label: "running"   },
  pending:              { dot: "bg-yellow-400",             label: "pending"   },
  canceled:             { dot: "bg-gray-400",               label: "canceled"  },
  skipped:              { dot: "bg-gray-300",               label: "skipped"   },
  created:              { dot: "bg-gray-300",               label: "created"   },
  manual:               { dot: "bg-gray-400",               label: "manual"    },
  scheduled:            { dot: "bg-blue-300",               label: "scheduled" },
  waiting_for_resource: { dot: "bg-yellow-300",             label: "waiting"   },
  preparing:            { dot: "bg-yellow-300",             label: "preparing" },
};

export const BUCKETS = {
  needs:    { id: "needs",    label: "Needs your review",         accentBar: "before:bg-orange-500", iconColor: "text-orange-600", pillBg: "bg-orange-500 text-white" },
  approved: { id: "approved", label: "You approved · still open", accentBar: "before:bg-green-500",  iconColor: "text-green-600",  pillBg: "bg-gray-200 text-gray-700" },
  mine:     { id: "mine",     label: "Your open MRs",             accentBar: "before:bg-blue-500",   iconColor: "text-blue-600",   pillBg: "bg-gray-200 text-gray-700" },
  mention:  { id: "mention",  label: "Mentioned you",             accentBar: "before:bg-purple-400", iconColor: "text-purple-500", pillBg: "bg-gray-200 text-gray-700" },
};
