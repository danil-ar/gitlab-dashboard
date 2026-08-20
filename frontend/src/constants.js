export const STATE_OPTS = [
  { value: "opened", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all",    label: "All states" },
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

// GitLab's detailed_merge_status. Only states worth a chip are listed: things
// the row already shows in its own column (threads, approvals, conflicts) would
// just be saying the same thing twice.
export const MERGE_STATUS = {
  MERGEABLE:   { label: "ready",       hint: "Every merge requirement is met",              cls: "bg-green-50 text-green-700 border-green-300" },
  NEED_REBASE: { label: "needs rebase", hint: "The branch has to be rebased before merging", cls: "bg-amber-50 text-amber-700 border-amber-300" },
};

// Past this, an MR reads as sitting rather than moving, and its age is worth
// noticing without reading the number.
export const STALE_DAYS = 30;

export const BUCKETS = {
  needs:    { id: "needs",    label: "Needs your review",         description: "Open MRs in your projects you haven't approved yet", accentBar: "before:bg-orange-500", iconColor: "text-orange-600", pillBg: "bg-orange-500 text-white",        headerBorder: "border-l-orange-500", headerBg: "bg-orange-50/60" },
  approved: { id: "approved", label: "You approved",             description: "You approved, but the MR is still waiting to merge", accentBar: "before:bg-green-500",  iconColor: "text-green-600",  pillBg: "bg-green-100 text-green-700",     headerBorder: "border-l-green-500",  headerBg: "bg-green-50/60"  },
  mine:     { id: "mine",     label: "Your open MRs",             description: "MRs you created that are still open",           accentBar: "before:bg-blue-500",   iconColor: "text-blue-600",   pillBg: "bg-blue-100 text-blue-700",       headerBorder: "border-l-blue-500",   headerBg: "bg-blue-50/60"   },
  mention:  { id: "mention",  label: "Mentioned you",             description: "MRs where you were tagged that are not already in a bucket above",     accentBar: "before:bg-purple-400", iconColor: "text-purple-500", pillBg: "bg-purple-100 text-purple-700",   headerBorder: "border-l-purple-500", headerBg: "bg-purple-50/60" },
};
