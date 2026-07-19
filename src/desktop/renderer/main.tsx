import React from "react";
import { createRoot } from "react-dom/client";

import { DesktopApp } from "./app.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Desktop root element was not found");
createRoot(root).render(<React.StrictMode><DesktopApp /></React.StrictMode>);

