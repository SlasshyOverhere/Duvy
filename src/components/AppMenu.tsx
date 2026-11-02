import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { ContextMenu, type ContextAction } from "./ui";

/**
 * The window's own right-click menu. WebView2 ships a browser menu full of
 * page-actions that mean nothing here, so it is replaced everywhere, and views
 * that have something better to offer open their own menu first.
 */
export function AppMenu() {
  const { back, route, notify } = useApp();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [selection, setSelection] = useState("");

  useEffect(() => {
    const onMenu = (event: MouseEvent) => {
      // A view already claimed this click, so its menu is the one to show.
      if (event.defaultPrevented) return;
      // Text fields keep the native menu: paste and cut live there.
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA"
      ) {
        return;
      }
      event.preventDefault();
      setSelection(String(window.getSelection() ?? "").trim());
      setAt({ x: event.clientX, y: event.clientY });
    };
    window.addEventListener("contextmenu", onMenu);
    return () => window.removeEventListener("contextmenu", onMenu);
  }, []);

  if (!at) return null;

  const copy = () => {
    navigator.clipboard
      .writeText(selection)
      .then(() => notify("Copied"))
      .catch(() => notify("Could not copy that", "error"));
  };

  const actions: ContextAction[] = [];
  if (selection) actions.push({ label: "Copy", onSelect: copy });
  actions.push({
    label: "Back",
    icon: "back",
    disabled: route.name === "home",
    onSelect: back,
  });
  actions.push({
    label: "Reload",
    icon: "refresh",
    onSelect: () => window.location.reload(),
  });

  return (
    <ContextMenu
      x={at.x}
      y={at.y}
      title="Duvy"
      actions={actions}
      onClose={() => setAt(null)}
    />
  );
}
