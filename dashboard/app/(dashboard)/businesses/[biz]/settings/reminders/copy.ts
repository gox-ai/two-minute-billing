/** "15 days and 3 days", largest first, distinct. Shared by the page and its rows. */
export function leadDaysLine(days: number[]): string {
  const parts = [...new Set(days)]
    .sort((a, b) => b - a)
    .map((d) => `${d} day${d === 1 ? "" : "s"}`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
