export function linksOutside(
  report: { successful?: number; success_map?: Record<string, { url: string }[]> },
  root: string,
): { source: string; url: string }[];
