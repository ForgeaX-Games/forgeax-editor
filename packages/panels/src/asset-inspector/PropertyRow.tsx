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
    <div className="f-row">
      <span className="f-name" title={label}>{label}</span>
      <span className="f-val"><span className="f-fact">{display}</span></span>
    </div>
  );
}
