import React from "react";
import ReactDOM from "react-dom/client";
import SimpleCoordinatorApp from "./SimpleCoordinatorApp";
import "./styles.css";

document.body.classList.add("simple-page");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SimpleCoordinatorApp />
  </React.StrictMode>,
);
