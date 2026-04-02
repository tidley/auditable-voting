import { pageUrl } from "./basePath";

type PageNavProps = {
  current: "home" | "vote" | "dashboard" | "simple";
};

const links = [
  { key: "home", href: pageUrl(), label: "Control room" },
  { key: "vote", href: pageUrl("vote.html"), label: "Voter portal" },
  { key: "dashboard", href: pageUrl("dashboard.html"), label: "Dashboard" },
  { key: "simple", href: pageUrl("simple.html"), label: "Simple UI" },
] as const;

export default function PageNav({ current }: PageNavProps) {
  return (
    <nav className="page-nav" aria-label="Primary">
      {links.map((link) => (
        <a
          key={link.key}
          className={`page-nav-link${current === link.key ? " is-active" : ""}`}
          href={link.href}
          aria-current={current === link.key ? "page" : undefined}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}
