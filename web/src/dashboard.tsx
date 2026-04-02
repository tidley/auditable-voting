import React from "react";
import ReactDOM from "react-dom/client";
import SimpleAppShell from "./SimpleAppShell";
import "./styles.css";

if (typeof document !== "undefined") {
  document.body.classList.add("simple-page");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SimpleAppShell initialRole="coordinator" />
  </React.StrictMode>
);
