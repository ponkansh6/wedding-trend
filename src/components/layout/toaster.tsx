"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";

/**
 * next-themes の解決済みテーマを sonner に橋渡しする薄いラッパー。
 * sonner 自体は attribute="class" 戦略を認識しないため、明示的に渡す。
 */
export function Toaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner theme={resolvedTheme === "dark" ? "dark" : "light"} richColors position="top-center" />
  );
}
