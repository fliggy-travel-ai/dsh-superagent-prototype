import { createContext } from 'react';

export interface MockHostTheme {
  colors: {
    surface0: string;
    surface1: string;
    surface2: string;
    border: string;
    foreground: string;
    foregroundMuted: string;
    accent: string;
    accentForeground: string;
    statusSuccess: string;
    statusWarning: string;
    statusDanger: string;
  };
}

export const HostThemeContext = createContext<MockHostTheme | null>(null);

export type ToastVariant = 'default' | 'info' | 'success' | 'warning' | 'error';
type ToastListener = (message: string, variant: ToastVariant) => void;
const listeners = new Set<ToastListener>();
export const toastBus = {
  emit(message: string, variant: ToastVariant) {
    for (const listener of listeners) listener(message, variant);
  },
  subscribe(listener: ToastListener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};
