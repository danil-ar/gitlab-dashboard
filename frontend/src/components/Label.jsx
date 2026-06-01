export default function Label({ children }) {
  return (
    <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[11px] border border-gray-200/80 whitespace-nowrap">
      {children}
    </span>
  );
}
