"use client";

import { useEffect, useState } from "react";

const THEMES = [
  { id: "calm", label: "Calm" },
  { id: "editorial", label: "Editorial" },
  { id: "noir", label: "Noir" },
] as const;

type VisualTheme = (typeof THEMES)[number]["id"];

const STORAGE_KEY = "dynamic-workflows-visual-theme";

export function VisualThemeSwitcher() {
  const [theme, setTheme] = useState<VisualTheme>("calm");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    const initial = THEMES.some((item) => item.id === saved)
      ? (saved as VisualTheme)
      : "calm";
    setTheme(initial);
    document.documentElement.dataset.visualTheme = initial;
  }, []);

  function selectTheme(nextTheme: VisualTheme) {
    setTheme(nextTheme);
    document.documentElement.dataset.visualTheme = nextTheme;
    window.localStorage.setItem(STORAGE_KEY, nextTheme);
  }

  return (
    <div className="visual-theme-switcher" aria-label="Visual style" role="group">
      {THEMES.map((item) => (
        <button
          key={item.id}
          className="visual-theme-option"
          type="button"
          aria-pressed={theme === item.id}
          onClick={() => selectTheme(item.id)}
        >
          <span className={`visual-theme-swatch ${item.id}`} aria-hidden="true" />
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
