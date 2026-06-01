export function classifyMR(mr, meId) {
  if (!meId || mr.state !== "opened") return null;
  const iAmAuthor = mr.author?.id === meId;
  const iApproved = mr.approved_by_users?.some((u) => u.id === meId);
  if (iAmAuthor) return "mine";
  if (iApproved) return "approved";
  return "needs";
}
