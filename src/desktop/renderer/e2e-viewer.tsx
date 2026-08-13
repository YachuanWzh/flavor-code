/**
 * Electron's product-facing E2E workspace delegates visual fidelity to the
 * existing D2C implementation. Keeping this facade separate lets the desktop
 * information architecture evolve without renaming D2C runtime contracts,
 * report storage, IPC channels, or CLI-facing capabilities.
 */
export { E2eViewer } from "./d2c-viewer.js";
