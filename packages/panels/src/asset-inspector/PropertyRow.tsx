interface PropertyRowProps {
  label: string;
  value: unknown;
}

export function PropertyRow({ label, value }: PropertyRowProps) {
  const display = value === undefined || value === null
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

  return (
    <div className="field" style={{ display: 'flex', gap: 8 }}>
      <label style={{ minWidth: 100, flexShrink: 0 }}>{label}</label>
      <span style={{ wordBreak: 'break-all' }}>{display}</span>
    </div>
  );
}
