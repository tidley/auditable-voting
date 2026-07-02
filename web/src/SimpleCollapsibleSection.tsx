import { useEffect, useId, useState, type ReactNode } from "react";
import { UiButton } from "./ui/DesignLayer";

export default function SimpleCollapsibleSection({
  title,
  titleToggleLabel,
  headerAction,
  children,
  defaultCollapsed = false,
  renderWhenExpanded = false,
  expandSignal,
  hideToggle = false,
}: {
  title: ReactNode;
  titleToggleLabel?: string;
  headerAction?: ReactNode;
  children: ReactNode;
  defaultCollapsed?: boolean;
  renderWhenExpanded?: boolean;
  expandSignal?: number;
  hideToggle?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const isCollapsed = hideToggle ? false : collapsed;
  const titleId = useId();
  const bodyId = `${titleId}-body`;

  useEffect(() => {
    if (expandSignal === undefined || expandSignal <= 0) {
      return;
    }
    setCollapsed(false);
  }, [expandSignal]);

  return (
    <section
      className={`simple-voter-section simple-collapsible-section${isCollapsed ? " is-collapsed" : ""}`}
      aria-labelledby={titleId}
    >
      <div className="simple-collapsible-header">
        {hideToggle ? (
          <h2 id={titleId} className="simple-voter-section-title simple-collapsible-title">{title}</h2>
        ) : titleToggleLabel ? (
          <h2 id={titleId} className="simple-voter-section-title simple-collapsible-title">
            <UiButton
              icon={isCollapsed ? "chevronRight" : "chevronDown"}
              className="simple-collapsible-title-toggle"
              aria-expanded={!isCollapsed}
              aria-controls={bodyId}
              onPress={() => setCollapsed((current) => !current)}
            >
              {isCollapsed ? `Show ${titleToggleLabel}` : `Hide ${titleToggleLabel}`}
            </UiButton>
          </h2>
        ) : (
          <h2 id={titleId} className="simple-voter-section-title simple-collapsible-title">{title}</h2>
        )}
        {headerAction ? (
          <div className="simple-collapsible-header-action">
            {headerAction}
          </div>
        ) : null}
        {!hideToggle && !titleToggleLabel ? (
          <UiButton
            icon={isCollapsed ? "chevronRight" : "chevronDown"}
            className="simple-collapsible-toggle"
            aria-expanded={!isCollapsed}
            aria-controls={bodyId}
            onPress={() => setCollapsed((current) => !current)}
          >
            {isCollapsed ? "Show" : "Hide"}
          </UiButton>
        ) : null}
      </div>
      <div id={bodyId} className="simple-collapsible-body">
        <div className="simple-collapsible-body-inner">
          {!renderWhenExpanded || !isCollapsed ? children : null}
        </div>
      </div>
    </section>
  );
}
