export default function Button({ onClick, loading, disabled, variant, children }) {
  return (
    <button
      className={`btn ${variant === "stop" ? "btn-stop" : ""}`}
      onClick={onClick}
      disabled={loading || disabled}
    >
      {loading ? "..." : children}
    </button>
  );
}
