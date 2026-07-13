let lastInteraction = Date.now();
let lastScroll = 0;

export function updateLastInteractionTime(): void { lastInteraction = Date.now(); }
export function flushInteractionTime(): void { void lastInteraction; }
export function markScrollActivity(): void { lastScroll = Date.now(); }
export function getIsScrollDraining(): boolean { return Date.now() - lastScroll < 150; }
