/**
 * The message box of the screen the Person is on, when it has one. There is one composer on any
 * screen, and it marks its field with `data-keeps-draft` (`Composer`), which is how something
 * outside the conversation (a row that is answered by writing) finds it without being handed it.
 */
export const messageField = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[data-keeps-draft]')
