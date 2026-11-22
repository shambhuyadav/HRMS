import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names, letting a later Tailwind class replace an earlier one of the same kind (shadcn/ui's helper). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
