import AccountForm from "./AccountForm";

export default function LoginScreen({ onLogin }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 w-full max-w-md">
        <div className="flex items-center gap-2.5 mb-2">
          <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 grid place-items-center text-white text-sm font-bold select-none">⌘</span>
          <h1 className="text-lg font-semibold text-gray-900">GitLab Dashboard</h1>
        </div>
        <p className="text-sm text-gray-500 mb-6">Connect your GitLab account to get started.</p>
        <AccountForm onSuccess={onLogin} />
      </div>
    </div>
  );
}
