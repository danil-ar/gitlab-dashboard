import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * The dimmed page, the box and the ways out: Escape and a click outside.
 * Rendered on <body>, so a parent's spacing or overflow can't reach the overlay.
 */
export default function Modal({ label, onClose, className = "", overlayClassName = "", children }) {
  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 ${overlayClassName}`} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={label} className={className} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
