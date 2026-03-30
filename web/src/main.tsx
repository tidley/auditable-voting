import React from "react";
import ReactDOM from "react-dom/client";
import DemoApp from "./DemoApp";
import "./styles.css";

if (typeof document !== "undefined") {
  document.body.classList.add("demo-page");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DemoApp />
  </React.StrictMode>
);
