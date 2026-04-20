import React from "react";
import ReactDOM from "react-dom/client";
import SimpleAppShell from "./SimpleAppShell";
import { installDynamicImportRecovery } from "./dynamicImportRecovery";
import "./styles.css";

document.body.classList.add("simple-page");
installDynamicImportRecovery();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SimpleAppShell initialRole="coordinator" />
  </React.StrictMode>,
);
