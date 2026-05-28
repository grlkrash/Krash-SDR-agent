// RFC-style CSV serializer (quoted fields when needed). Pairs with exclusions/parseCsv.

const escapeCell = (value: string): string => {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};

export const serializeCsv = (headers: string[], rows: string[][]): string => {
  const lines = [
    headers.map(escapeCell).join(','),
    ...rows.map((row) => row.map(escapeCell).join(',')),
  ];
  return `${lines.join('\n')}\n`;
};
