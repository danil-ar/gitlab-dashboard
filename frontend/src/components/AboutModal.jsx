import Modal from "./Modal";

export default function AboutModal({ onClose }) {
  return (
    <Modal label="About" onClose={onClose} overlayClassName="backdrop-blur-sm" className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-6 pb-5 flex items-center gap-4">
        <span className="w-12 h-12 rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 grid place-items-center text-white text-xl font-bold select-none shrink-0">
          ⌘
        </span>
        <div>
          <h2 className="text-base font-semibold text-gray-900">GitLab MRs</h2>
          <p className="text-xs text-gray-400 font-mono mt-0.5">v{__APP_VERSION__}</p>
        </div>
      </div>

      <div className="h-px bg-gray-100 mx-6" />

      {/* Description */}
      <div className="px-6 py-4">
        <p className="text-sm text-gray-600 leading-relaxed">
          Personal GitLab dashboard for tracking merge requests across multiple projects and profiles.
        </p>
      </div>

      {/* Features */}
      <div className="px-6 pb-4 space-y-2">
        {[
          ["Triage",   "Review queue grouped by role — reviewer, author, mention"],
          ["Browse",   "Full MR list with filters by state, scope, project"],
          ["To-Do",    "GitLab todos — mentions, reviews, build alerts"],
          ["Profiles", "Multiple GitLab accounts with encrypted session cookies"],
        ].map(([title, desc]) => (
          <div key={title} className="flex gap-2.5">
            <span className="text-[11px] font-semibold text-gray-900 w-16 shrink-0 pt-px">{title}</span>
            <span className="text-[11px] text-gray-500 leading-relaxed">{desc}</span>
          </div>
        ))}
      </div>

      <div className="h-px bg-gray-100 mx-6" />

      {/* Stack */}
      <div className="px-6 py-3 flex items-center gap-2 flex-wrap">
        {["React", "Vite", "Tailwind", "FastAPI", "GitLab API"].map((t) => (
          <span key={t} className="text-[10px] font-mono px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full">{t}</span>
        ))}
      </div>

      <div className="h-px bg-gray-100 mx-6" />

      {/* Footer */}
      <div className="px-6 py-4 flex justify-end">
        <button
          onClick={onClose}
          className="px-4 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
        >
          Close
        </button>
      </div>
    </Modal>
  );
}
