import { useState } from "react";

export default function Avatar({ user, size = "sm" }) {
  const [err, setErr] = useState(false);
  const dim = size === "md" ? "w-7 h-7 text-xs" : "w-5 h-5 text-[10px]";
  if (user?.avatar_url && !err) {
    return (
      <img
        src={user.avatar_url}
        alt={user.name}
        className={`${dim} rounded-full object-cover`}
        onError={() => setErr(true)}
      />
    );
  }
  return (
    <span className={`${dim} rounded-full bg-gray-300 inline-flex items-center justify-center font-semibold text-gray-600 shrink-0`}>
      {user?.name?.[0]?.toUpperCase() ?? "?"}
    </span>
  );
}
