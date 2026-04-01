import React from "react";
import ReactDOM from "react-dom/client";
import SimpleUiApp from "./SimpleUiApp";
import "./styles.css";

document.body.classList.add("simple-page");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SimpleUiApp />
  </React.StrictMode>,
);
