export type MessageTimestamp = {
  dateTime: string;
  label: string;
};

export function formatMessageTimestamp(
  value: string,
  locale?: string,
): MessageTimestamp | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const label = new Intl.DateTimeFormat(locale || undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
  return { dateTime: date.toISOString(), label };
}
