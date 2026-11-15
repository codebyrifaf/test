/** Intentionally static: Step 1 has no session or connection state. */
export function ConnectionStatus() {
  return (
    <span className="status-badge">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-slate-400" />
      Not connected
    </span>
  );
}
