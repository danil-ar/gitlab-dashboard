import { useState, useEffect } from "react";

export default function LoginScreen({ onLogin }) {
  const [url, setUrl]             = useState("https://");
  const [token, setToken]         = useState("");
  const [label, setLabel]         = useState("");
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => { if (d.gitlab_url) setUrl(d.gitlab_url); })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gitlab_url: url.trim().replace(/\/$/, ""),
          token: token.trim(),
          label: label.trim(),
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.detail || `Error ${r.status}`);
      }
      await onLogin();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 w-full max-w-md">
        <div className="flex items-center gap-2.5 mb-2">
          <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 grid place-items-center text-white text-sm font-bold select-none">⌘</span>
          <h1 className="text-lg font-semibold text-gray-900">GitLab MRs</h1>
        </div>
        <p className="text-sm text-gray-500 mb-6">Connect your GitLab account to get started.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">GitLab URL</label>
            <input
              type="url" required value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://gitlab.example.com"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Personal Access Token</label>
            <div className="relative">
              <input
                type={showToken ? "text" : "password"} required value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="glpat-xxxxxxxxxxxxxxxxxxxx"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 pr-14 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              <button type="button" onClick={() => setShowToken((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600">
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              Needs <code className="bg-gray-100 px-1 rounded">api</code> or{" "}
              <code className="bg-gray-100 px-1 rounded">read_api</code> scope.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Label <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              type="text" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="My work account"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 break-all">
              {error}
            </p>
          )}

          <button type="submit" disabled={loading}
            className="w-full py-2.5 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50">
            {loading ? "Connecting…" : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}
