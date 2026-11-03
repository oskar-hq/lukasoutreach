import { useIsPresent, type MotionValue } from 'motion/react';
import { createContext, useContext, type MutableRefObject } from 'react';

export interface SwipeAction {
  label: string;
  /** `false` zurückgeben, wenn die Seite stehen bleiben soll (z. B. weil erst eine Vorschau öffnet). */
  run: () => boolean | void;
  enabled?: boolean;
}

export interface SwipeActions {
  left: SwipeAction;
  right: SwipeAction;
}

interface SwipeContextValue {
  x: MotionValue<number>;
  actionsRef: MutableRefObject<SwipeActions | null>;
}

export const SwipeContext = createContext<SwipeContextValue | null>(null);

export function useSwipeContext() {
  return useContext(SwipeContext);
}

/** Jede Aufgabe meldet hier, was Wischen nach links bzw. rechts auslöst (dieselben Aktionen wie ← / →). */
export function useSwipeActions(actions: SwipeActions) {
  const context = useContext(SwipeContext);
  const present = useIsPresent();
  if (context && present) context.actionsRef.current = actions;
}

export { project } from '../../lib/gesture';
