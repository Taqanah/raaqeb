/**
 * The class helper every shadcn copy uses: clsx joins, tailwind-merge lets a
 * caller's class win over the copy's own.
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
