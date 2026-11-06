/** The bar every page starts with: what this is on the left, what you can do on the right. */
export default function PageHeader({ title, subtitle, className = "", children }) {
  return (
    <header className={`px-5 py-3.5 border-b border-gray-200 bg-white flex flex-wrap items-center gap-x-3 gap-y-2 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {subtitle && <div className="text-xs text-gray-500">{subtitle}</div>}
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div>}
    </header>
  );
}
