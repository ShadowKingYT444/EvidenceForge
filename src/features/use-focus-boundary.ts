"use client";

import { type RefObject, useEffect, useRef } from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const activeBoundaries: symbol[] = [];

function visibleFocusableElements(boundary: HTMLElement) {
  return Array.from(
    boundary.querySelectorAll<HTMLElement>(focusableSelector),
  ).filter((element) => element.getClientRects().length > 0);
}

function makeBackgroundInert(boundary: HTMLElement) {
  const priorStates: Array<[HTMLElement, boolean]> = [];
  let branch: HTMLElement = boundary;

  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling instanceof HTMLElement && sibling !== branch) {
        priorStates.push([sibling, sibling.inert]);
        sibling.inert = true;
      }
    }
    branch = parent;
    if (parent === document.body) break;
  }

  return () => {
    for (const [element, inert] of priorStates) element.inert = inert;
  };
}

export function useFocusBoundary({
  active,
  boundaryRef,
  initialFocusRef,
  onDismiss,
}: {
  active: boolean;
  boundaryRef: RefObject<HTMLElement | null>;
  initialFocusRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}) {
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!active || !boundaryRef.current) return;

    const boundary = boundaryRef.current;
    const boundaryToken = Symbol("focus-boundary");
    activeBoundaries.push(boundaryToken);
    const restoreBackground = makeBackgroundInert(boundary);
    const focusFrame = requestAnimationFrame(() => {
      initialFocusRef.current?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (activeBoundaries.at(-1) !== boundaryToken) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = visibleFocusableElements(boundary);
      if (focusable.length === 0) {
        event.preventDefault();
        boundary.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const focused = document.activeElement;
      if (event.shiftKey && (focused === first || !boundary.contains(focused))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (focused === last || !boundary.contains(focused))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      const boundaryIndex = activeBoundaries.lastIndexOf(boundaryToken);
      if (boundaryIndex !== -1) activeBoundaries.splice(boundaryIndex, 1);
      restoreBackground();
    };
  }, [active, boundaryRef, initialFocusRef]);
}
