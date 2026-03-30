import React from "react";
import ReactDOM from "react-dom/client";
import VotingApp from "./VotingApp";
import "./styles.css";

if (typeof document !== "undefined") {
  document.body.classList.add("app-page");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <VotingApp />
  </React.StrictMode>
);
