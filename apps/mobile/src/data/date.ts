/** Formats an optional epoch timestamp for the compact date labels used by mobile screens. */
export const when = (value: number | null) =>
  value === null
    ? 'No date set'
    : new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
