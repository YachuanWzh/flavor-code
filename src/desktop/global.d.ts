import type { FlavorDesktopApi } from "./contracts.js";

declare global {
  interface Window {
    flavorDesktop: FlavorDesktopApi;
  }
}

export {};

