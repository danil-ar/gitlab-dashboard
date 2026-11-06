import { useEffect, useState } from "react";
import { api } from "../api";

const INPUT = "w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500";

export default function AccountForm({ onSuccess, onCancel }) {
  const [url, setUrl]             = useState("https://");
  const [token, setToken]         = useState("");
  const [label, setLabel]         = useState("");
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  useEffect(() => {
    api.get("/api/config")
      .then((d) => { if (d.gitlab_url) setUrl(d.gitlab_url); })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post("/api/auth/login", {
        gitlab_url: url.trim().replace(/\/$/, ""),
        token: token.trim(),
        label: label.trim(),
      });
      await onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">GitLab URL</label>
        <input
          type="url" required value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://gitlab.example.com"
          className={INPUT}
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Personal Access Token</label>
        <div className="relative">
          <input
            type={showToken ? "text" : "password"} required value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="glpat-…"
            className={`${INPUT} pr-14 font-mono`}
          />
          <button type="button" onClick={() => setShowToken((s) => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-600">
            {showToken ? "Hide" : "Show"}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          Needs <code className="bg-gray-100 px-1 rounded">api</code> scope.{" "}
          <code className="bg-gray-100 px-1 rounded">read_api</code> can view MRs, but approving and To-Do actions won't work.
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Label <span className="font-normal text-gray-500">(optional)</span>
        </label>
        <input
          type="text" value={label} onChange={(e) => setLabel(e.target.value)}
          placeholder="My work account"
          className={INPUT}
        />
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 break-all">{error}</p>
      )}

      <div className="flex gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel}
            className="flex-1 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors">
            Cancel
          </button>
        )}
        <button type="submit" disabled={loading}
          className="flex-1 py-2.5 bg-orange-700 hover:bg-orange-800 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50">
          {loading ? "Connecting…" : "Connect"}
        </button>
      </div>
    </form>
  );
}
