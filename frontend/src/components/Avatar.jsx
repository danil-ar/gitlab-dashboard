import { useState, useEffect } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Avatars are loaded straight from GitLab, which works as long as the browser
// has a GitLab session. When it does not, the backend can fetch them with the
// profile's token — so a broken image retries through the proxy before giving
// up and falling back to initials.

export default function Avatar({ user, size = "sm", showTooltip = false }) {
  const src = user?.avatar_url;
  const [stage, setStage] = useState("direct");
  const dim = size === "md" ? "w-7 h-7 text-xs" : "w-5 h-5 text-[11px]";

  useEffect(() => { setStage("direct"); }, [src]);

  const proxyable = /^https?:\/\//i.test(src ?? "");
  const url =
    stage === "direct"  ? src :
    stage === "proxied" ? `/api/avatar?url=${encodeURIComponent(src)}` :
    null;

  const img = url
    ? <img src={url} alt={user.name}
           className={`${dim} rounded-full object-cover`}
           onError={() => setStage(stage === "direct" && proxyable ? "proxied" : "initials")} />
    : <span className={`${dim} rounded-full bg-gray-300 inline-flex items-center justify-center font-semibold text-gray-600 shrink-0`}>
        {user?.name?.[0]?.toUpperCase() ?? "?"}
      </span>;

  if (!showTooltip || !user?.name) return img;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{img}</TooltipTrigger>
      <TooltipContent>{user.name}</TooltipContent>
    </Tooltip>
  );
}
