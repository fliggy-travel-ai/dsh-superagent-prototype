const listeners = new Set<() => void>();
export function onCapacityChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function capacityChanged() { for (const listener of listeners) listener(); }
