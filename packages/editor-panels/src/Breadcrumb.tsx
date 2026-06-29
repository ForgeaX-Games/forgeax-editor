interface BreadcrumbProps {
  path: string;
  onNavigate: (dir: string) => void;
}

export function Breadcrumb({ path, onNavigate }: BreadcrumbProps) {
  if (!path) return null;

  const parts = path.split('/');
  const crumbs: { label: string; path: string }[] = [];
  let acc = '';
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    crumbs.push({ label: p, path: acc });
  }

  return (
    <div className="cb-breadcrumb">
      <span className="cb-crumb cb-crumb-link" onClick={() => onNavigate('')}>
        All
      </span>
      {crumbs.map(c => (
        <span key={c.path}>
          <span className="cb-crumb-sep">/</span>
          <span className="cb-crumb cb-crumb-link" onClick={() => onNavigate(c.path)}>
            {c.label}
          </span>
        </span>
      ))}
    </div>
  );
}
