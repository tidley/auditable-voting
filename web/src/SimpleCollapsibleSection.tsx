import { useId, useState, type ReactNode } from "react";

export default function SimpleCollapsibleSection({
  title,
  children,
  defaultCollapsed = false,
  renderWhenExpanded = false,
}: {
  title: string;
  children: ReactNode;
  defaultCollapsed?: boolean;
  renderWhenExpanded?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const titleId = useId();
  const bodyId = `${titleId}-body`;

  return (
    <section
      className={`simple-voter-section simple-collapsible-section${collapsed ? " is-collapsed" : ""}`}
      aria-labelledby={titleId}
    >
      <div className="simple-collapsible-header">
        <h2 id={titleId} className="simple-voter-section-title simple-collapsible-title">{title}</h2>
        <button
          type="button"
          className="simple-collapsible-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>
      <div id={bodyId} className="simple-collapsible-body">
        <div className="simple-collapsible-body-inner">
          {!renderWhenExpanded || !collapsed ? children : null}
        </div>
      </div>
    </section>
  );
}
