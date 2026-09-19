export default function Button({ onClick, loading, disabled, variant = "primary", size, children, type = "button" }) {
  const cls = ["btn", `btn-${variant}`, size ? `btn-${size}` : ""].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} onClick={onClick} disabled={loading || disabled}>
      {loading ? "…" : children}
    </button>
  );
}
