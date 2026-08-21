import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * クラス名を結合し、Tailwind の衝突を解決する共通ヘルパー。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
